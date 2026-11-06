import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_ETAG_HEADER,
  ADMIN_MAX_BODY_BYTES,
  type AdminMaintenanceList,
  type ErrorResponse,
  isAdminRevision,
} from "@lorenzh/pulse-contract";
import { BodyError, readBody, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import type { AdminAuthFailures } from "./admin-auth-failures.ts";
import { type AdminAuthThrottle, createAdminAuthThrottle } from "./admin-auth-throttle.ts";
import type { AuditLog } from "./audit-log.ts";
import {
  type AuditPath,
  AuditQueryError,
  auditPathOf,
  auditRouteOf,
  serveAudit,
} from "./audit-routes.ts";
import type { CheckEdit, CheckWriter } from "./check-write.ts";
import type { Config } from "./config.ts";
import { configExport, exportBytes } from "./config-export.ts";
import type {
  ConfigEdit,
  ConfigKind,
  ConfigWriter,
  FileKind,
  WriteActor,
  WriteFailure,
  WriteOutcome,
} from "./config-write.ts";
import { ConfigWriteError } from "./config-write.ts";
import type { MaintenanceWriter, WindowEdit } from "./maintenance-write.ts";
import type { ConfigWriteAction, ConfigWriteResult, Metrics } from "./metrics.ts";
import { handleTokenRoute, type TokenPath, tokenPathOf, tokenRouteOf } from "./token-routes.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken, TokenStore } from "./token-store.ts";

export interface AdminRoutesDeps {
  writer: ConfigWriter;
  /** The configuration in use: the applied file with the effective checks; read by the export. */
  config: () => Omit<Config, "secrets">;
  /** Writes of `/admin/checks`: database checks, never the checks file. */
  checks: CheckWriter;
  /** Writes of `/admin/maintenance`: database windows, never the checks file. */
  maintenance: MaintenanceWriter;
  /** `GET /admin/maintenance`: the effective and shadowed windows with the admin revision. */
  maintenanceList: () => AdminMaintenanceList;
  metrics: Pick<Metrics, "recordConfigWrite">;
  /** Authenticates the Bearer credential and serves `/admin/tokens*`. */
  tokens: TokenStore;
  /** Serves `/admin/audit` and `/admin/audit/export`. */
  audit: AuditLog;
  now: () => number;
  info: (message: string, fields: Record<string, string>) => void;
  warn: (message: string, fields: Record<string, string>) => void;
  /** Logs and counts a failed authentication; shared with the manual-incident routes. */
  authFailures: AdminAuthFailures;
  /** Shared with the manual-incident routes; defaults to an instance of its own. */
  authThrottle?: AdminAuthThrottle;
}

const ADMIN_PATH = /^\/admin\/(config|checks|components|maintenance)(?:\/([^/]+))?$/;

const KINDS: Record<string, ConfigKind> = {
  checks: "check",
  components: "component",
  maintenance: "maintenance",
};

const ACTION_OF_METHOD: Record<string, ConfigWriteAction> = {
  POST: "create",
  PUT: "replace",
  DELETE: "delete",
};

const FAILURE_STATUS: Record<WriteFailure, number> = {
  stale: 412,
  invalid: 422,
  conflict: 409,
  "not-found": 404,
  readonly: 503,
  error: 500,
};

const FAILURE_RESULT: Record<WriteFailure, ConfigWriteResult> = {
  stale: "stale",
  invalid: "invalid",
  conflict: "conflict",
  "not-found": "invalid",
  readonly: "readonly",
  error: "error",
};

/** A failure the route decides itself, before the writer runs. */
class RouteError extends Error {
  override name = "RouteError";
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function etag(revision: string): Record<string, string> {
  return { [ADMIN_ETAG_HEADER]: `"${revision}"` };
}

/** The revision of an `If-Match` header: quoted and never `*`; undefined when missing (428 later). */
function ifMatchOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const quoted = /^"([^"]*)"$/.exec(header.trim());
  const value = quoted?.[1];
  if (value === undefined || !isAdminRevision(value)) {
    throw new RouteError(400, 'If-Match must be one quoted revision: "sha256-<hex>"');
  }
  return value;
}

/** Read a body that the route ignores, only to enforce the size limit on every method. */
async function discardBody(req: IncomingMessage): Promise<void> {
  await readBodyJson(req, true);
}

/** The JSON body; a DELETE body is read only to enforce the size limit, then dropped. */
async function readBodyJson(req: IncomingMessage, isDelete: boolean): Promise<unknown> {
  try {
    if (!isDelete) return await readJsonBody(req, { maxBytes: ADMIN_MAX_BODY_BYTES });
    await readBody(req, ADMIN_MAX_BODY_BYTES);
    return undefined;
  } catch (err) {
    if (!(err instanceof BodyError)) throw err;
    if (err.code === "too-large") throw new RouteError(413, "request body too large");
    throw new RouteError(400, "body is not valid JSON");
  }
}

function decodeRef(raw: string): string {
  // A malformed escape names nothing: the writer answers 404 for it after the checks that come
  // first in the status order.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function bodyId(body: unknown): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined;
}

const SEGMENT: Record<ConfigKind, string> = {
  check: "checks",
  component: "components",
  maintenance: "maintenance",
};

function locationOf(kind: ConfigKind, ref: string): string {
  return `/admin/${SEGMENT[kind]}/${encodeURIComponent(ref)}`;
}

function sendError(res: ServerResponse, status: number, error: string, headers = {}): void {
  const body: ErrorResponse = { error };
  sendJson(res, status, body, headers);
}

interface Target {
  kind: ConfigKind;
  /** Undefined on the collection path. */
  ref: string | undefined;
}

/** Handle `/admin/*`. Returns false for a path that is not an admin route. */
export function createAdminHandler(
  deps: AdminRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const throttle =
    deps.authThrottle ??
    createAdminAuthThrottle({
      tokens: deps.tokens,
      authFailures: deps.authFailures,
      now: deps.now,
      warn: deps.warn,
      metrics: { recordAdminAuthThrottled: () => undefined },
    });
  const authorize = (
    req: IncomingMessage,
    route: string,
    permission: Permission,
  ): AuthenticatedToken => {
    const access = throttle.authorize({
      remoteAddress: req.socket.remoteAddress,
      authorization: req.headers.authorization,
      route,
      permission,
    });
    if (access.kind === "ok") return access.token;
    if (access.kind === "throttled") {
      throw new RouteError(429, "too many requests", {
        "retry-after": String(access.retryAfterSeconds),
      });
    }
    if (access.status === 403) throw new RouteError(403, "forbidden");
    throw new RouteError(401, "unauthorized", { "www-authenticate": "Bearer" });
  };

  const applyWrite = (
    kind: ConfigKind,
    action: ConfigWriteAction,
    ref: string | undefined,
    body: unknown,
    ifMatch: string,
    actor: WriteActor,
  ): Promise<WriteOutcome> => {
    // Database check and window writes never touch the file, so they need no writable directory.
    if (kind === "check") return deps.checks.apply(checkEditOf(action, ref, body), ifMatch, actor);
    if (kind === "maintenance") {
      return deps.maintenance.apply(windowEditOf(action, ref, body), ifMatch, actor);
    }
    try {
      deps.writer.assertWritable();
    } catch (err) {
      throw err instanceof ConfigWriteError ? err : new RouteError(503, "checks file not writable");
    }
    return deps.writer.apply(editOf(kind, action, ref, body), ifMatch, actor);
  };

  const write = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: Target,
    action: ConfigWriteAction,
    caller: AuthenticatedToken,
  ): Promise<void> => {
    const { kind, ref } = target;
    const body = await readBodyJson(req, action === "delete");
    const ifMatch = ifMatchOf(req.headers["if-match"]);
    if (action === "replace" && bodyId(body) !== ref) {
      throw new RouteError(400, "body id must equal the id in the path");
    }
    if (ifMatch === undefined) throw new RouteError(428, "If-Match is required");
    const actor = { tokenId: caller.id, name: caller.name };
    const outcome = await applyWrite(kind, action, ref, body, ifMatch, actor);
    deps.metrics.recordConfigWrite(kind, action, "ok");
    const id = String((action === "create" ? bodyId(body) : ref) ?? "");
    deps.info("config write", { token: caller.name, kind, action, id });
    const headers = etag(outcome.revision);
    if (action === "delete") {
      res.writeHead(204, headers).end();
    } else if (action === "create") {
      sendJson(res, 201, outcome.entity, {
        ...headers,
        location: locationOf(kind, id),
      });
    } else {
      sendJson(res, 200, outcome.entity, headers);
    }
  };

  const fail = (
    res: ServerResponse,
    err: unknown,
    target: Target | undefined,
    action: ConfigWriteAction | undefined,
  ): void => {
    let status: number;
    let message: string;
    let headers: Record<string, string> = {};
    let result: ConfigWriteResult = "invalid";
    if (err instanceof RouteError) {
      ({ status, message, headers } = err);
    } else if (err instanceof ConfigWriteError) {
      status = FAILURE_STATUS[err.code];
      message = err.message;
      result = FAILURE_RESULT[err.code];
    } else {
      throw err;
    }
    if (target !== undefined && action !== undefined && status !== 405) {
      // No body, header value, secret or token goes into the line.
      deps.warn("config write failed", { status: String(status), kind: target.kind, action });
      deps.metrics.recordConfigWrite(target.kind, action, result);
    }
    sendError(res, status, message, headers);
  };

  const tokenRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: TokenPath,
  ): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    let caller: AuthenticatedToken;
    try {
      caller = authorize(req, tokenRouteOf(path), "token-admin");
    } catch (err) {
      fail(res, err, undefined, undefined);
      return;
    }
    const tokenDeps = { store: deps.tokens, now: deps.now, info: deps.info };
    await handleTokenRoute(tokenDeps, req, res, path, caller);
  };

  const auditRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: AuditPath,
  ): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    try {
      authorize(req, auditRouteOf(path), "audit-read");
      if (req.method !== "GET") throw new RouteError(405, "method not allowed", { Allow: "GET" });
      await discardBody(req);
      await serveAudit(deps.audit, res, path, url.searchParams);
    } catch (err) {
      if (res.headersSent) throw err;
      fail(
        res,
        err instanceof AuditQueryError ? new RouteError(400, err.message) : err,
        undefined,
        undefined,
      );
    }
  };

  /** Serve the audit and token routes; false for any other path. */
  const otherRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const auditPath = auditPathOf(url.pathname);
    if (auditPath !== null) {
      await auditRoute(req, res, url, auditPath);
      return true;
    }
    const tokenPath = tokenPathOf(url.pathname);
    if (tokenPath === null) return false;
    await tokenRoute(req, res, tokenPath);
    return true;
  };

  const serveConfig = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    sub: string | undefined,
  ): Promise<void> => {
    if (sub !== undefined && sub !== "export") throw new RouteError(404, "not found");
    if (req.method !== "GET") throw new RouteError(405, "method not allowed", { Allow: "GET" });
    await discardBody(req);
    const view = deps.writer.view();
    if (sub === undefined) {
      sendJson(res, 200, view, etag(view.revision));
      return;
    }
    if (url.search !== "") throw new RouteError(400, "export takes no query parameters");
    res
      .writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="checks.json"',
        "cache-control": "no-store",
        ...etag(view.revision),
      })
      .end(exportBytes(configExport(deps.config())));
  };

  const serveMaintenanceList = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    await discardBody(req);
    if (url.search !== "") throw new RouteError(400, "maintenance takes no query parameters");
    const list = deps.maintenanceList();
    sendJson(res, 200, list, { "cache-control": "no-store", ...etag(list.revision) });
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await otherRoute(req, res, url)) return true;
    const match = ADMIN_PATH.exec(url.pathname);
    if (match === null) return false;
    const section = match[1] ?? "";
    const method = req.method ?? "GET";
    let target: Target | undefined;
    let action: ConfigWriteAction | undefined;
    try {
      const caller = authorize(req, ...routeAccess(section, match[2], method));
      if (section === "config") {
        await serveConfig(req, res, url, match[2]);
        return true;
      }
      if (isMaintenanceList(section, match[2], method)) {
        await serveMaintenanceList(req, res, url);
        return true;
      }
      const kind = KINDS[section];
      action = ACTION_OF_METHOD[method];
      if (kind === undefined || action === undefined) {
        throw new RouteError(405, "method not allowed", { Allow: allowOf(kind, match[2]) });
      }
      target = {
        kind,
        ref: match[2] === undefined ? undefined : decodeRef(match[2]),
      };
      if ((action === "create") !== (target.ref === undefined)) {
        throw new RouteError(405, "method not allowed", { Allow: allowOf(kind, target.ref) });
      }
      await write(req, res, target, action, caller);
    } catch (err) {
      if (res.headersSent) throw err;
      fail(res, err, target, action);
    }
    return true;
  };
}

/** The route pattern of the request metric (never the raw path), and the permission it needs. */
function routeAccess(
  section: string,
  id: string | undefined,
  method: string,
): [string, Permission] {
  const route = `/admin/${section}${id === undefined ? "" : "/:id"}`;
  const isRead = section === "config" || isMaintenanceList(section, id, method);
  return [route, isRead ? "config-read" : "config-write"];
}

/** `GET /admin/maintenance` reads like `GET /admin/config`; every other window method writes. */
function isMaintenanceList(section: string, id: string | undefined, method: string): boolean {
  return section === "maintenance" && id === undefined && method === "GET";
}

/** The methods of a list path (no item ref) or an item path. */
function allowOf(kind: ConfigKind | undefined, ref: unknown): string {
  if (ref !== undefined) return "PUT, DELETE";
  return kind === "maintenance" ? "GET, POST" : "POST";
}

function editOf(
  kind: FileKind,
  action: ConfigWriteAction,
  ref: string | undefined,
  body: unknown,
): ConfigEdit {
  if (action === "create") return { kind, action, body };
  if (ref === undefined) throw new RouteError(405, "method not allowed", { Allow: "POST" });
  return action === "replace" ? { kind, action, ref, body } : { kind, action, ref };
}

function windowEditOf(
  action: ConfigWriteAction,
  ref: string | undefined,
  body: unknown,
): WindowEdit {
  if (action === "create") return { action, body };
  if (ref === undefined) throw new RouteError(405, "method not allowed", { Allow: "GET, POST" });
  return action === "replace" ? { action, ref, body } : { action, ref };
}

function checkEditOf(action: ConfigWriteAction, ref: string | undefined, body: unknown): CheckEdit {
  if (action === "create") return { action, body };
  if (ref === undefined) throw new RouteError(405, "method not allowed", { Allow: "POST" });
  return action === "replace" ? { action, ref, body } : { action, ref };
}
