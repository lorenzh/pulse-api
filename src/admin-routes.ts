import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_ETAG_HEADER,
  ADMIN_MAX_BODY_BYTES,
  type ErrorResponse,
  isAdminRevision,
} from "@lorenzh/pulse-contract";
import { BodyError, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import type { ConfigEdit, ConfigKind, ConfigWriter, WriteFailure } from "./config-write.ts";
import { ConfigWriteError } from "./config-write.ts";
import type { ConfigWriteAction, ConfigWriteResult, Metrics } from "./metrics.ts";
import { matchesAnyToken } from "./tokens.ts";

export interface AdminRoutesDeps {
  writer: ConfigWriter;
  metrics: Pick<Metrics, "recordConfigWrite">;
  /** Admin tokens by token value; the name is what the log line carries. */
  adminTokens: ReadonlyMap<string, string>;
  /** True for a valid probe token: it gets 403 instead of 401. */
  isProbeToken: (authorization: string | undefined) => boolean;
  info: (message: string, fields: Record<string, string>) => void;
  warn: (message: string, fields: Record<string, string>) => void;
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

/** The revision of an `If-Match` header: required, quoted, and never `*`. */
function ifMatchOf(header: string | undefined): string {
  if (header === undefined) throw new RouteError(428, "If-Match is required");
  const quoted = /^"([^"]*)"$/.exec(header.trim());
  const value = quoted?.[1];
  if (value === undefined || !isAdminRevision(value)) {
    throw new RouteError(400, 'If-Match must be one quoted revision: "sha256-<hex>"');
  }
  return value;
}

async function readBodyJson(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(req, { maxBytes: ADMIN_MAX_BODY_BYTES });
  } catch (err) {
    if (!(err instanceof BodyError)) throw err;
    if (err.code === "too-large") throw new RouteError(413, "request body too large");
    throw new RouteError(400, "body is not valid JSON");
  }
}

// eslint-disable-next-line sonarjs/function-return-type -- an id is text, a window position is a number
function decodeRef(kind: ConfigKind, raw: string): string | number {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // A malformed escape cannot name anything: it reads as an unknown id.
    throw new RouteError(404, "not found");
  }
  if (kind !== "maintenance") return text;
  if (!/^\d{1,9}$/.test(text)) throw new RouteError(404, "not found");
  return Number(text);
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
  const authorize = (req: IncomingMessage): string => {
    const header = req.headers.authorization;
    const tokens = [...deps.adminTokens.keys()];
    if (!matchesAnyToken(tokens, header)) {
      if (deps.isProbeToken(header)) throw new RouteError(403, "forbidden");
      throw new RouteError(401, "unauthorized", { "www-authenticate": "Bearer" });
    }
    const presented = /^Bearer (.+)$/i.exec(header ?? "")?.[1];
    return (presented === undefined ? undefined : deps.adminTokens.get(presented)) ?? "admin";
  };

  const write = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: Target,
    action: ConfigWriteAction,
    tokenName: string,
  ): Promise<void> => {
    const { kind, ref } = target;
    const hasBody = action !== "delete";
    const body = hasBody ? await readBodyJson(req) : undefined;
    const ifMatch = ifMatchOf(req.headers["if-match"]);
    if (action === "replace" && kind !== "maintenance" && bodyId(body) !== ref) {
      throw new RouteError(400, "body id must equal the id in the path");
    }
    try {
      deps.writer.assertWritable();
    } catch (err) {
      throw err instanceof ConfigWriteError ? err : new RouteError(503, "checks file not writable");
    }
    const edit = editOf(kind, action, ref, body);
    const outcome = await deps.writer.apply(edit, ifMatch);
    deps.metrics.recordConfigWrite(kind, action, "ok");
    const created = kind === "maintenance" ? (outcome.index ?? 0) : bodyId(body);
    const id = String((action === "create" ? created : ref) ?? "");
    deps.info("config write", { token: tokenName, kind, action, id });
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

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = ADMIN_PATH.exec(url.pathname);
    if (match === null) return false;
    const section = match[1] ?? "";
    const method = req.method ?? "GET";
    let target: Target | undefined;
    let action: ConfigWriteAction | undefined;
    try {
      const tokenName = authorize(req);
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
      await write(req, res, target, action, tokenName);
    } catch (err) {
      if (res.headersSent) throw err;
      fail(res, err, target, action);
    }
    return true;
  };
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
