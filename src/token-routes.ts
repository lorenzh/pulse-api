import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type ErrorResponse,
  TOKEN_ID_PREFIX,
  TOKEN_MAX_BODY_BYTES,
  type TokenMetadata,
  type TokenSecretResponse,
  type TokensResponse,
  validateTokenCreateInput,
} from "@lorenzh/pulse-contract";
import { BodyError, readBody, sendJson } from "@lorenzh/pulse-kit";
import { canGrant } from "./token-scopes.ts";
import {
  type Actor,
  type AuthenticatedToken,
  type TokenStore,
  TokenStoreError,
  type TokenStoreErrorReason,
} from "./token-store.ts";

/** The latest expiry a create accepts, counted from now: 3650 days. */
export const TOKEN_MAX_LIFETIME_MS = 3650 * 86_400_000;

export interface TokenRoutesDeps {
  store: TokenStore;
  now: () => number;
  info: (message: string, fields: Record<string, string>) => void;
}

/** The parts of a `/admin/tokens[/<id>[/rotate|/revoke]]` path. */
export interface TokenPath {
  /** Undefined on the collection path. */
  id: string | undefined;
  action: "rotate" | "revoke" | undefined;
}

const TOKEN_ID = new RegExp(`^${TOKEN_ID_PREFIX}[0-9a-f]{24}$`);
const TOKENS_PATH = /^\/admin\/tokens(?:\/([^/]+)(?:\/(rotate|revoke))?)?$/;

/** Parse a token route path; null when the path is not one. */
export function tokenPathOf(path: string): TokenPath | null {
  const match = TOKENS_PATH.exec(path);
  if (match === null) return null;
  const action = match[2] === "rotate" || match[2] === "revoke" ? match[2] : undefined;
  return { id: match[1], action };
}

/** The route pattern of a token path, for metrics and auth-failure lines. */
export function tokenRouteOf(path: TokenPath): string {
  if (path.id === undefined) return "/admin/tokens";
  return path.action === undefined ? "/admin/tokens/:id" : `/admin/tokens/:id/${path.action}`;
}

/** A refusal with its status; the message is the response text. */
class TokenRouteError extends Error {
  override name = "TokenRouteError";
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const REASON_STATUS: Record<TokenStoreErrorReason, number> = {
  "not-found": 404,
  revoked: 409,
  expired: 409,
  overlap: 409,
  "last-admin": 409,
};

async function readText(req: IncomingMessage): Promise<string> {
  try {
    return await readBody(req, TOKEN_MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyError && err.code === "too-large") {
      throw new TokenRouteError(413, "request body too large");
    }
    if (err instanceof BodyError) throw new TokenRouteError(400, "body is not valid JSON");
    throw err;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TokenRouteError(400, "body is not valid JSON");
  }
}

/** A rotate or revoke body: empty or `{}`. */
async function readEmptyBody(req: IncomingMessage): Promise<void> {
  const text = await readText(req);
  if (text.trim() === "") return;
  const body = parseJson(text);
  const isEmptyObject =
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Reflect.ownKeys(body).length === 0;
  if (!isEmptyObject) throw new TokenRouteError(400, "body must be empty or {}");
}

function notFound(): TokenRouteError {
  return new TokenRouteError(404, "token not found");
}

function forbidden(): TokenRouteError {
  return new TokenRouteError(403, "forbidden");
}

/** Handle one token route for an authenticated caller that holds `admin`. */
export async function handleTokenRoute(
  deps: TokenRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: TokenPath,
  caller: AuthenticatedToken,
): Promise<void> {
  try {
    await dispatch(deps, req, res, path, caller);
  } catch (err) {
    if (res.headersSent) throw err;
    if (err instanceof TokenRouteError) {
      sendError(res, err.status, err.message, err.headers);
    } else if (err instanceof TokenStoreError) {
      sendError(res, REASON_STATUS[err.reason], err.message);
    } else {
      throw err;
    }
  }
}

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Record<string, string> = {},
): void {
  const body: ErrorResponse = { error };
  sendJson(res, status, body, headers);
}

async function dispatch(
  deps: TokenRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: TokenPath,
  caller: AuthenticatedToken,
): Promise<void> {
  const method = req.method ?? "GET";
  const actor: Actor = { tokenId: caller.id, name: caller.name };
  if (path.id === undefined) {
    if (method === "GET") {
      await readText(req);
      const body: TokensResponse = { tokens: deps.store.list() };
      sendJson(res, 200, body);
      return;
    }
    if (method !== "POST")
      throw new TokenRouteError(405, "method not allowed", { Allow: "GET, POST" });
    await create(deps, req, res, caller, actor);
    return;
  }
  if (path.action === undefined) {
    if (method !== "GET") throw new TokenRouteError(405, "method not allowed", { Allow: "GET" });
    await readText(req);
    sendJson(res, 200, mustGet(deps.store, path.id));
    return;
  }
  if (method !== "POST") throw new TokenRouteError(405, "method not allowed", { Allow: "POST" });
  await readEmptyBody(req);
  const target = mustGet(deps.store, path.id);
  if (!canGrant(caller.scopes, target.scopes)) throw forbidden();
  if (path.action === "rotate") {
    const made = deps.store.rotate(target.id, actor);
    deps.info("token write", { token: caller.name, action: "rotate", id: target.id });
    const body: TokenSecretResponse = {
      token: made.token,
      secret: made.secret,
      previousValidUntil: made.token.previousValidUntil,
    };
    sendJson(res, 200, body);
    return;
  }
  const revoked = deps.store.revoke(target.id, actor);
  deps.info("token write", { token: caller.name, action: "revoke", id: target.id });
  sendJson(res, 200, revoked);
}

function mustGet(store: TokenStore, id: string): TokenMetadata {
  // A malformed id names nothing, so it reads as an unknown one.
  const token = TOKEN_ID.test(id) ? store.get(id) : null;
  if (token === null) throw notFound();
  return token;
}

async function create(
  deps: TokenRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  caller: AuthenticatedToken,
  actor: Actor,
): Promise<void> {
  const parsed = validateTokenCreateInput(parseJson(await readText(req)));
  if (!parsed.ok) throw new TokenRouteError(400, parsed.error);
  const input = parsed.value;
  const now = deps.now();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (expiresAt <= now || expiresAt > now + TOKEN_MAX_LIFETIME_MS)) {
    throw new TokenRouteError(400, "expiresAt: must be in the future and at most 3650 days ahead");
  }
  if (!canGrant(caller.scopes, input.scopes)) throw forbidden();
  const made = deps.store.create(
    {
      name: input.name,
      scopes: input.scopes,
      // Results trim their location, so the binding is stored trimmed too.
      location: input.location?.trim() ?? null,
      expiresAt,
      source: "api",
    },
    actor,
  );
  deps.info("token write", { token: caller.name, action: "create", id: made.token.id });
  const body: TokenSecretResponse = {
    token: made.token,
    secret: made.secret,
    previousValidUntil: null,
  };
  sendJson(res, 201, body, { location: `/admin/tokens/${made.token.id}` });
}
