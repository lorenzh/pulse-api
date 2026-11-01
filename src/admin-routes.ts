import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_ETAG_HEADER,
  ADMIN_MAX_BODY_BYTES,
  type ErrorResponse,
  isAdminRevision,
} from "@lorenzh/pulse-contract";
import { BodyError, readBody, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import { type AdminAuthFailures, adminAccess } from "./admin-auth-failures.ts";
import type { AuditLog } from "./audit-log.ts";
import {
  type AuditPath,
  AuditQueryError,
  auditPathOf,
  auditRouteOf,
  serveAudit,
} from "./audit-routes.ts";
import type { ConfigEdit, ConfigKind, ConfigWriter, WriteFailure } from "./config-write.ts";
import { ConfigWriteError } from "./config-write.ts";
import type { ConfigWriteAction, ConfigWriteResult, Metrics } from "./metrics.ts";
import { handleTokenRoute, type TokenPath, tokenPathOf, tokenRouteOf } from "./token-routes.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken, TokenStore } from "./token-store.ts";

export interface AdminRoutesDeps {
  writer: ConfigWriter;
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

// eslint-disable-next-line sonarjs/function-return-type -- an id is text, a window position is a number
function decodeRef(kind: ConfigKind, raw: string): string | number {
  // A malformed escape or a non-numeric index names nothing: the writer answers 404 for it after
  // the checks that come first in the status order.
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return raw;
  }
  return kind === "maintenance" && /^\d{1,9}$/.test(text) ? Number(text) : text;
}

function bodyId(body: unknown): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined;
}

const SEGMENT: Record<ConfigKind, string> = {
  check: "checks",
  component: "components",
  maintenance: "maintenance",
};

function locationOf(kind: ConfigKind, ref: string | number): string {
  return `/admin/${SEGMENT[kind]}/${encodeURIComponent(String(ref))}`;
}

function sendError(res: ServerResponse, status: number, error: string, headers = {}): void {
  const body: ErrorResponse = { error };
  sendJson(res, status, body, headers);
}

interface Target {
  kind: ConfigKind;
  /** Undefined on the collection path. */
  ref: string | number | undefined;
}

/** Handle `/admin/*`. Returns false for a path that is not an admin route. */
export function createAdminHandler(
  deps: AdminRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const authorize = (
    req: IncomingMessage,
    route: string,
    permission: Permission,
  ): AuthenticatedToken => {
    const access = adminAccess(deps.tokens, req.headers.authorization, permission);
    if (access.kind === "ok") return access.token;
    deps.authFailures.record(route, access.status, access.token);
    if (access.status === 403) throw new RouteError(403, "forbidden");
    throw new RouteError(401, "unauthorized", { "www-authenticate": "Bearer" });
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
    if (action === "replace" && kind !== "maintenance" && bodyId(body) !== ref) {
      throw new RouteError(400, "body id must equal the id in the path");
    }
    if (ifMatch === undefined) throw new RouteError(428, "If-Match is required");
    try {
      deps.writer.assertWritable();
    } catch (err) {
      throw err instanceof ConfigWriteError ? err : new RouteError(503, "checks file not writable");
    }
    const edit = editOf(kind, action, ref, body);
    const outcome = await deps.writer.apply(edit, ifMatch, {
      tokenId: caller.id,
      name: caller.name,
    });
    deps.metrics.recordConfigWrite(kind, action, "ok");
    const created = kind === "maintenance" ? (outcome.index ?? 0) : bodyId(body);
    const id = String((action === "create" ? created : ref) ?? "");
    deps.info("config write", { token: caller.name, kind, action, id });
    const headers = etag(outcome.revision);
    if (action === "delete") {
      res.writeHead(204, headers).end();
    } else if (action === "create") {
      sendJson(res, 201, outcome.entity, {
        ...headers,
        location: locationOf(kind, typeof created === "number" ? created : String(created)),
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
      const caller = authorize(req, ...routeAccess(section, match[2]));
      if (section === "config") {
        if (match[2] !== undefined) throw new RouteError(404, "not found");
        if (method !== "GET") throw new RouteError(405, "method not allowed", { Allow: "GET" });
        const view = deps.writer.view();
        sendJson(res, 200, view, etag(view.revision));
        return true;
      }
      const kind = KINDS[section];
      action = ACTION_OF_METHOD[method];
      if (kind === undefined || action === undefined) {
        throw new RouteError(405, "method not allowed");
      }
      target = {
        kind,
        ref: match[2] === undefined ? undefined : decodeRef(kind, match[2]),
      };
      if ((action === "create") !== (target.ref === undefined)) {
        throw new RouteError(405, "method not allowed", {
          Allow: target.ref === undefined ? "POST" : "PUT, DELETE",
        });
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
function routeAccess(section: string, id: string | undefined): [string, Permission] {
  const route = `/admin/${section}${id === undefined ? "" : "/:id"}`;
  return [route, section === "config" ? "config-read" : "config-write"];
}

function editOf(
  kind: ConfigKind,
  action: ConfigWriteAction,
  ref: string | number | undefined,
  body: unknown,
): ConfigEdit {
  if (action === "create") return { kind, action, body };
  if (ref === undefined) throw new RouteError(405, "method not allowed");
  return action === "replace" ? { kind, action, ref, body } : { kind, action, ref };
}
