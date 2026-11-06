import type { IncomingMessage, ServerResponse } from "node:http";
import { type ErrorResponse, isAdminRevision } from "@lorenzh/pulse-contract";
import { BodyError, readBody, sendJson } from "@lorenzh/pulse-kit";
import type { AdminAuthThrottle } from "./admin-auth-throttle.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken } from "./token-store.ts";

/** Decision 16: the text of a 412 on a runtime configuration write. */
export const STALE_SETTINGS = "the settings changed: reload them and retry";

/** An expected failure of a status or notify route, answered as an `ErrorResponse`. */
export class RuntimeRouteError extends Error {
  override name = "RuntimeRouteError";
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** The quoted revision of an `etag` header. */
export function etagOf(revision: string): string {
  return `"${revision}"`;
}

/** The body as text within `maxBytes`: 413 beyond, 400 when it cannot be read. */
export async function readText(req: IncomingMessage, maxBytes: number): Promise<string> {
  try {
    return await readBody(req, maxBytes);
  } catch (err) {
    if (!(err instanceof BodyError)) throw err;
    if (err.code === "too-large") throw new RuntimeRouteError(413, "request body too large");
    throw new RuntimeRouteError(400, "request body could not be read");
  }
}

/** The body as JSON within `maxBytes`. */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const text = await readText(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    // The parser message quotes the body, so it is not kept.
    throw new RuntimeRouteError(400, "body is not valid JSON");
  }
}

/** The unquoted revision of `If-Match`: 428 when missing, 400 when not one quoted revision. */
export function ifMatchOf(header: string | undefined): string {
  if (header === undefined) throw new RuntimeRouteError(428, "If-Match is required");
  const value = /^"([^"]*)"$/.exec(header.trim())?.[1];
  if (value === undefined || !isAdminRevision(value)) {
    throw new RuntimeRouteError(400, 'If-Match must be one quoted revision: "sha256-<hex>"');
  }
  return value;
}

/** Throttle, then 401 or 403; the token on success. */
export function authorizeRuntime(
  throttle: AdminAuthThrottle,
  req: IncomingMessage,
  route: string,
  permission: Permission,
): AuthenticatedToken {
  const access = throttle.authorize({
    remoteAddress: req.socket.remoteAddress,
    authorization: req.headers.authorization,
    route,
    permission,
  });
  if (access.kind === "ok") return access.token;
  if (access.kind === "throttled") {
    throw new RuntimeRouteError(429, "too many requests", {
      "retry-after": String(access.retryAfterSeconds),
    });
  }
  if (access.status === 403) throw new RuntimeRouteError(403, "forbidden");
  throw new RuntimeRouteError(401, "unauthorized", { "www-authenticate": "Bearer" });
}

/** 405 with `Allow` unless `method` is one of `allow` (a `, ` list). */
export function assertMethod(method: string, allow: string): void {
  if (!allow.split(", ").includes(method)) {
    throw new RuntimeRouteError(405, "method not allowed", { Allow: allow });
  }
}

/** Answer a `RuntimeRouteError`; rethrow anything else. */
export function sendRuntimeError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof RuntimeRouteError) || res.headersSent) throw err;
  const body: ErrorResponse = { error: err.message };
  sendJson(res, err.status, body, err.headers);
}
