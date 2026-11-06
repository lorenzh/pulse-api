import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type Check,
  MAX_REASON_LENGTH as CONTRACT_MAX_REASON_LENGTH,
  type Component,
  type ErrorResponse,
  MANUAL_INCIDENT_MAX_BODY_BYTES,
  MAX_TIMER_MS,
  type Result,
  validatePostResultRequest,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { BodyError, handleOps, readBody, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import { type AdminAuthFailures, createAdminAuthFailures } from "./admin-auth-failures.ts";
import { type AdminAuthThrottle, createAdminAuthThrottle } from "./admin-auth-throttle.ts";
import { auditPathOf, auditRouteOf } from "./audit-routes.ts";
import { componentsUptime, componentsWithState } from "./components.ts";
import { MAX_LOCATION_LENGTH } from "./location-limits.ts";
import {
  isPrivateManualPath,
  isPrivateManualTarget,
  ManualRouteError,
  serveManualIncidentRoutes,
} from "./manual-incident-routes.ts";
import {
  ManualIncidentConflictError,
  ManualIncidentInputError,
  ManualIncidentNotFoundError,
  type ManualIncidentStore,
} from "./manual-incidents.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import {
  DEFAULT_LOCATION,
  HEARTBEAT_LOCATION,
  type Service,
  UnknownCheckError,
} from "./service.ts";
import { type StatusPath, statusPathOf, statusRouteOf } from "./status-settings-routes.ts";
import { tokenPathOf, tokenRouteOf } from "./token-routes.ts";
import { canUse } from "./token-scopes.ts";
import type { Actor, TokenStore } from "./token-store.ts";
import { bearerSecret } from "./tokens.ts";

const MAX_BODY = 1_000_000;
const MAX_PING_BODY = 1024;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_RESULT_AGE_MS = 7 * 86_400_000;
const MAX_REASON_LENGTH = CONTRACT_MAX_REASON_LENGTH;
const MAX_ATTEMPTS = 100;
const MAX_LATENCY_MS = MAX_TIMER_MS;
/** Covers every expiry up to year 9999 (the X.509 and RDAP maximum), even from a clock at the epoch. */
const MAX_CERT_DAYS = 3_000_000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_INCIDENT_LIMIT = 1000;
export const MAX_INCIDENT_LIMIT = 5000;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
};

class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
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

/** Map a body failure to the HttpError the API answers with. */
function bodyFailure(err: unknown): unknown {
  if (!(err instanceof BodyError)) return err;
  if (err.code === "too-large") return new HttpError(413, "request body too large");
  if (err.code === "invalid-json") return new HttpError(400, "body is not valid JSON");
  return new HttpError(400, "request body could not be read");
}

function isIntegerIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** How far ahead of the clock a result may be: the check's interval, at most 60 s. Heartbeat and unknown checks get 60 s. */
export function maxFutureSkewMs(check: Check | undefined): number {
  if (check === undefined || check.type === "heartbeat") return MAX_FUTURE_SKEW_MS;
  return Math.min(check.intervalMs, MAX_FUTURE_SKEW_MS);
}

function checkTimestamp(v: unknown, now: number, limit: number): string | undefined {
  if (typeof v !== "number" || !Number.isInteger(v))
    return "timestamp must be an integer (epoch ms)";
  if (v > now + limit) return `timestamp is more than ${limit} ms in the future`;
  if (v < now - MAX_RESULT_AGE_MS) return "timestamp is older than 7 days";
  return undefined;
}

function checkMeasurements(b: Record<string, unknown>): string | undefined {
  if (b.statusCode !== null && !isIntegerIn(b.statusCode, 100, 599))
    return "statusCode must be null or an integer from 100 to 599";
  if (!isIntegerIn(b.latencyMs, 0, MAX_LATENCY_MS))
    return `latencyMs: must be an integer 0..${MAX_LATENCY_MS}`;
  if (b.reason !== null && typeof b.reason !== "string") return "reason must be a string or null";
  if (typeof b.reason === "string" && b.reason.length > MAX_REASON_LENGTH)
    return `reason must be at most ${MAX_REASON_LENGTH} characters`;
  if (
    b.certDaysLeft !== undefined &&
    b.certDaysLeft !== null &&
    !isIntegerIn(b.certDaysLeft, -MAX_CERT_DAYS, MAX_CERT_DAYS)
  ) {
    return `certDaysLeft must be null or an integer from -${MAX_CERT_DAYS} to ${MAX_CERT_DAYS}`;
  }
  if (b.attempts !== undefined && !isIntegerIn(b.attempts, 1, MAX_ATTEMPTS))
    return `attempts must be an integer from 1 to ${MAX_ATTEMPTS}`;
  return undefined;
}

function parseLocation(v: unknown): string {
  if (v === undefined) return DEFAULT_LOCATION;
  if (typeof v !== "string") throw new TypeError("location must be a string");
  const trimmed = v.trim();
  if (trimmed.length > MAX_LOCATION_LENGTH)
    throw new TypeError(`location must be at most ${MAX_LOCATION_LENGTH} characters`);
  return trimmed === "" ? DEFAULT_LOCATION : trimmed;
}

/** Older probes send fractional latency; round a finite value >= 0 so the contract accepts it. */
function withRoundedLatency(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  if (Object.getPrototypeOf(body) !== Object.prototype) return body;
  const raw = Object.getOwnPropertyDescriptor(body, "latencyMs")?.value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return body;
  return { ...body, latencyMs: Math.round(raw) };
}

/** Validate a POST /results body against the clock `now` (epoch ms); returns an error message or the Result. */
// eslint-disable-next-line sonarjs/function-return-type -- the result is a deliberate Result-or-message union
export function validateResult(
  body: unknown,
  now: number,
  findCheck: (id: string) => Check | undefined,
): Result | string {
  // An accessor would run untrusted code when rounding copies the body; JSON.parse never makes one.
  if (
    typeof body === "object" &&
    body !== null &&
    Object.values(Object.getOwnPropertyDescriptors(body)).some((d) => !("value" in d))
  )
    return "body must not have accessor properties";
  const input = withRoundedLatency(body);
  const shape = validatePostResultRequest(input);
  if (!shape.ok) return shape.error;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "body must be a JSON object";
  }
  const b = input as Record<string, unknown>;
  if (typeof b.checkId !== "string" || b.checkId === "")
    return "checkId must be a non-empty string";
  const timestampError = checkTimestamp(b.timestamp, now, maxFutureSkewMs(findCheck(b.checkId)));
  if (timestampError !== undefined) return timestampError;
  if (b.status !== "up" && b.status !== "degraded" && b.status !== "down") {
    return 'status must be "up", "degraded" or "down"';
  }
  const measurementError = checkMeasurements(b);
  if (measurementError !== undefined) return measurementError;
  let location: string;
  try {
    location = parseLocation(b.location);
  } catch (err) {
    return err instanceof Error ? err.message : "location is invalid";
  }
  const result: Result = {
    checkId: b.checkId,
    timestamp: b.timestamp as number,
    status: b.status,
    statusCode: b.statusCode as number | null,
    latencyMs: b.latencyMs as number,
    reason: b.reason as string | null,
    location,
    attempts: (b.attempts as number | undefined) ?? 1,
  };
  if (b.certDaysLeft !== undefined) result.certDaysLeft = b.certDaysLeft as number | null;
  return result;
}

const RESULTS_PATH = /^\/checks\/([^/]+)\/results$/;
const LATENCY_PATH = /^\/checks\/([^/]+)\/latency$/;
const LOCATION_UPTIME_PATH = /^\/checks\/([^/]+)\/location-uptime$/;
const MANUAL_PATH = /^\/manual-incidents(?:\/([^/]+)(?:\/(updates|resolve))?)?$/;
const HEARTBEAT_PATH = /^\/heartbeat\/([^/]+)(?:\/([^/]+))?$/;
const ADMIN_ROUTE = /^\/admin\/(config|checks|components|maintenance)(\/[^/]+)?$/;
const ROUTES = [
  "/results",
  "/checks",
  "/probe/checks",
  "/uptime",
  "/latency",
  "/components",
  "/components/uptime",
  "/incidents",
  "/locations",
  "/maintenance",
  "/manual-incidents",
  "/healthz",
  "/readyz",
  "/metrics",
];

/** The route pattern of a path, so a metric label never holds a raw path or check id. */
function routeOf(rawUrl: string | undefined): string {
  let path: string;
  try {
    path = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    // An unparsable URL is answered with an error by the handler; it has no route.
    return "unmatched";
  }
  if (RESULTS_PATH.test(path)) return "/checks/:id/results";
  if (LATENCY_PATH.test(path)) return "/checks/:id/latency";
  if (LOCATION_UPTIME_PATH.test(path)) return "/checks/:id/location-uptime";
  if (HEARTBEAT_PATH.test(path)) return "/heartbeat/:id";
  const audit = auditPathOf(path);
  if (audit !== null) return auditRouteOf(audit);
  const token = tokenPathOf(path);
  if (token !== null) return tokenRouteOf(token);
  const status = statusPathOf(path);
  if (status !== null) return statusRouteOf(status);
  const admin = ADMIN_ROUTE.exec(path);
  if (admin?.[1] !== undefined)
    return admin[2] === undefined ? `/admin/${admin[1]}` : `/admin/${admin[1]}/:id`;
  const manual = MANUAL_PATH.exec(path);
  if (manual?.[1] !== undefined) {
    return manual[2] === undefined ? "/manual-incidents/:id" : `/manual-incidents/:id/${manual[2]}`;
  }
  return ROUTES.find((r) => r === path) ?? "unmatched";
}

type RuntimeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  path: StatusPath,
) => Promise<void>;

type LogFn = (message: string, fields: Record<string, string>) => void;

type Ops = {
  service: Service;
  metrics: Metrics;
  notReadyReason: () => string | undefined;
  heartbeatDigests: () => ReadonlyMap<string, string>;
  components: () => readonly Component[];
  manualIncidents: ManualIncidentStore;
  tokens: Pick<TokenStore, "authenticate">;
  /** False before the admin bootstrap: the manual-incident writes answer 404. */
  isAdminEnabled: boolean;
  authThrottle: AdminAuthThrottle;
  info: LogFn;
  warn: LogFn;
  /** Handles `/admin/*`; undefined when the config writes are off. */
  admin: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | undefined;
  /** Handles `/service/status/*`; undefined without the runtime settings. */
  runtime: RuntimeHandler | undefined;
};

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

const NO_DIGEST = Buffer.alloc(32);

/** A stored hex SHA-256 digest as bytes; anything else matches no secret. */
function storedDigest(hex: string | undefined): Buffer | undefined {
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

/** The secret from the path form, else from the Bearer header; undefined when neither is sent. */
function pingSecret(
  pathSecret: string | undefined,
  authorization: string | undefined,
): string | undefined {
  if (pathSecret !== undefined) return pathSecret;
  const match = /^Bearer (.+)$/i.exec(authorization ?? "");
  return match?.[1];
}

/**
 * Handle `/heartbeat/<id>[/<secret>]`. An unknown id and a wrong secret answer alike, so the
 * existence of an id is not revealed. The path and the secret are never logged or echoed.
 */
async function servePing(
  ops: Ops,
  now: () => number,
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    throw new HttpError(405, "method not allowed", { Allow: "GET, POST" });
  }
  let id: string | undefined;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch {
    // A malformed escape cannot name a check: it answers like an unknown id.
    id = undefined;
  }
  const expected = id === undefined ? undefined : storedDigest(ops.heartbeatDigests().get(id));
  const given = pingSecret(match[2], req.headers.authorization);
  // Digests of equal length keep the comparison constant-time; a missing side compares as zeros.
  const isValid =
    timingSafeEqual(expected ?? NO_DIGEST, digest(given ?? "")) &&
    expected !== undefined &&
    given !== undefined;
  if (!isValid || id === undefined) {
    throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
  }
  try {
    await readBody(req, MAX_PING_BODY);
  } catch (err) {
    throw bodyFailure(err);
  }
  try {
    ops.service.ingest(
      {
        checkId: id,
        timestamp: now(),
        status: "up",
        statusCode: null,
        latencyMs: 0,
        reason: null,
        location: HEARTBEAT_LOCATION,
        attempts: 1,
      },
      true,
    );
    ops.metrics.recordHeartbeatPing(id);
  } catch (err) {
    // An inactive check records nothing, but the job keeps working.
    if (!(err instanceof UnknownCheckError)) throw err;
  }
  res.writeHead(204).end();
}

const OPS_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz", "/metrics"]);

/** Serve `/healthz`, `/readyz` and `/metrics`. Returns false for any other path. None needs auth. */
function serveOps(ops: Ops, req: IncomingMessage, res: ServerResponse): boolean {
  // kit's handleOps answers a wrong method with plain text, so reject it here as JSON.
  // Same path rule as kit: the query string is ignored.
  const opsPath = (req.url ?? "/").split("?")[0] ?? "";
  if (OPS_PATHS.has(opsPath) && (req.method ?? "GET") !== "GET") {
    throw new HttpError(405, "method not allowed", { Allow: "GET" });
  }
  return handleOps(req, res, {
    // Liveness only: no database access, and 200 also while shutting down.
    live: () => ({ ready: true }),
    ready: () => {
      const reason = ops.notReadyReason();
      if (reason !== undefined) return { ready: false, reason };
      if (!ops.service.isDbReady()) return { ready: false, reason: "database unavailable" };
      return { ready: true };
    },
    metrics: () => ops.metrics.render(),
  });
}

/** A query integer of at least `min`; undefined when absent, a 400 when malformed. */
function parseCount(raw: string | null, name: string, min: number): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
    throw new HttpError(
      400,
      `${name} must be ${min === 0 ? "a non-negative" : "a positive"} integer`,
    );
  }
  return n;
}

/** Map the store's typed errors to the HttpError the API answers with. */
function manualFailure(err: unknown): unknown {
  if (err instanceof ManualIncidentInputError) return new HttpError(400, err.message);
  if (err instanceof ManualIncidentNotFoundError)
    return new HttpError(404, "manual incident not found");
  if (err instanceof ManualIncidentConflictError) return new HttpError(409, err.message);
  return err;
}

async function readManualBody(req: IncomingMessage, isOptional: boolean): Promise<unknown> {
  try {
    if (!isOptional) return await readJsonBody(req, { maxBytes: MANUAL_INCIDENT_MAX_BODY_BYTES });
    const text = await readBody(req, MANUAL_INCIDENT_MAX_BODY_BYTES);
    return text.trim() === "" ? undefined : await parseJson(text);
  } catch (err) {
    throw bodyFailure(err);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError("invalid-json", "body is not valid JSON");
  }
}

function manualFilter(url: URL): "open" | "resolved" | "all" {
  const status = url.searchParams.get("status");
  if (status === null || status === "all") return "all";
  if (status === "open" || status === "resolved") return status;
  throw new HttpError(400, 'status must be "open", "resolved" or "all"');
}

type ManualAction = "list" | "get" | "create" | "update" | "resolve" | "delete";

const MANUAL_ACTIONS: Record<string, ManualAction> = {
  "GET list": "list",
  "POST list": "create",
  "GET item": "get",
  "DELETE item": "delete",
  "POST updates": "update",
  "POST resolve": "resolve",
};
const MANUAL_ALLOW: Record<string, string> = {
  list: "GET, POST",
  item: "GET, DELETE",
  updates: "POST",
  resolve: "POST",
};

/** The id of the path, or undefined for the list path; a bad id answers 404 like an unknown one. */
function manualId(idText: string | undefined): number | undefined {
  if (idText === undefined) return undefined;
  if (!/^\d{1,15}$/.test(idText)) throw new HttpError(404, "not found");
  return Number(idText);
}

/** Authorize a manual-incident write; returns the caller as the audit entry names it. */
function requireAdmin(ops: Ops, req: IncomingMessage, route: string): Actor {
  // Before the admin bootstrap the feature is off and the write routes do not exist.
  if (!ops.isAdminEnabled) throw new HttpError(404, "not found");
  const access = ops.authThrottle.authorize({
    remoteAddress: req.socket.remoteAddress,
    authorization: req.headers.authorization,
    route,
    permission: "incident-write",
  });
  if (access.kind === "ok") return { tokenId: access.token.id, name: access.token.name };
  if (access.kind === "throttled") {
    throw new HttpError(429, "too many requests", {
      "retry-after": String(access.retryAfterSeconds),
    });
  }
  if (access.status === 403) throw new HttpError(403, "forbidden");
  throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
}

/** The location of the probe token in `header`; 401 without a valid one, 403 for another token. */
function requireProbe(ops: Ops, header: string | undefined): string {
  const secret = bearerSecret(header);
  const auth = secret === undefined ? undefined : ops.tokens.authenticate(secret);
  if (auth?.kind !== "ok") {
    throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
  }
  const { scopes, location } = auth.token;
  if (!canUse(scopes, "probe") || location === null) throw new HttpError(403, "forbidden");
  return location;
}

type ManualWrite = "create" | "update" | "resolve" | "delete";

const PRIVACY_KEYS = ["visibility", "draft"] as const;

/**
 * The legacy create always publishes a public incident. Its input schema strips unknown keys, so
 * a privacy key is refused here instead of being dropped silently.
 */
function refusePrivacyKeys(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  for (const key of PRIVACY_KEYS) {
    if (Object.hasOwn(body, key)) {
      throw new HttpError(400, `${key}: not accepted here; use /admin/manual-incidents`);
    }
  }
  return body;
}

/** Apply one write and answer it; returns the id of the incident written. */
async function applyManualWrite(
  store: ManualIncidentStore,
  req: IncomingMessage,
  res: ServerResponse,
  action: ManualWrite,
  id: number | undefined,
  actor: Actor,
): Promise<number> {
  // Each store call commits the change with its audit entry before the response is written.
  if (action === "create") {
    const created = store.create(refusePrivacyKeys(await readManualBody(req, false)), actor);
    sendJson(res, 201, created);
    return created.id;
  }
  // The action table gives these actions only on an item path, which has an id.
  if (id === undefined) throw new HttpError(404, "not found");
  switch (action) {
    case "update":
      sendJson(res, 201, store.addUpdate(id, await readManualBody(req, false), actor));
      return id;
    case "resolve":
      sendJson(res, 200, store.resolve(id, await readManualBody(req, true), actor));
      return id;
    case "delete":
      store.remove(id, actor);
      res.writeHead(204).end();
      return id;
    default: {
      const never: never = action;
      return never;
    }
  }
}

/** Run a write route and log it; the store's errors map to a status. */
async function writeManual(
  ops: Ops,
  req: IncomingMessage,
  res: ServerResponse,
  action: ManualWrite,
  id: number | undefined,
  actor: Actor,
): Promise<void> {
  try {
    const written = await applyManualWrite(ops.manualIncidents, req, res, action, id, actor);
    // Names, the action and the id only: no title, message, body or header value.
    ops.info("manual incident write", { token: actor.name, action, id: String(written) });
  } catch (err) {
    const failure = manualFailure(err);
    // A 500 is logged once, as "request failed".
    if (failure instanceof HttpError) {
      const fields: Record<string, string> = { status: String(failure.status), action };
      if (action !== "create" && id !== undefined) fields.id = String(id);
      ops.warn("manual incident write failed", fields);
    }
    throw failure;
  }
}

function manualRoute(shape: string): string {
  if (shape === "list") return "/manual-incidents";
  return shape === "item" ? "/manual-incidents/:id" : `/manual-incidents/:id/${shape}`;
}

/** Serve `/manual-incidents[/<id>[/updates|/resolve]]`. Writes need an admin token. */
async function serveManualIncidents(
  ops: Ops,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: RegExpExecArray,
): Promise<void> {
  const store = ops.manualIncidents;
  const id = manualId(match[1]);
  const shape = id === undefined ? "list" : (match[2] ?? "item");
  const action = MANUAL_ACTIONS[`${req.method ?? "GET"} ${shape}`];
  if (action === undefined) {
    throw new HttpError(405, "method not allowed", { Allow: MANUAL_ALLOW[shape] ?? "GET" });
  }
  if (action === "list") {
    sendJson(res, 200, store.list(manualFilter(url)));
    return;
  }
  if (action === "get") {
    const incident = id === undefined ? undefined : store.get(id);
    if (incident === undefined) throw new HttpError(404, "manual incident not found");
    sendJson(res, 200, incident);
    return;
  }
  const actor = requireAdmin(ops, req, manualRoute(shape));
  await writeManual(ops, req, res, action, id, actor);
}

function decodeCheckId(encoded: string | undefined): string {
  if (encoded === undefined) throw new HttpError(400, "bad check id");
  try {
    return decodeURIComponent(encoded);
  } catch {
    // decodeURIComponent throws URIError on malformed escapes: report it as a bad id
    throw new HttpError(400, "bad check id");
  }
}

const PLAIN_READS: ReadonlySet<string> = new Set([
  "/checks",
  "/probe/checks",
  "/uptime",
  "/latency",
  "/components",
  "/components/uptime",
  "/incidents",
  "/locations",
  "/maintenance",
]);

function isReadPath(path: string): boolean {
  return (
    PLAIN_READS.has(path) ||
    RESULTS_PATH.test(path) ||
    LATENCY_PATH.test(path) ||
    LOCATION_UPTIME_PATH.test(path)
  );
}

/** Parse the request target; only a `URL` failure becomes a quiet 400 without request data. */
function parseTarget(target: string | undefined): URL {
  try {
    return new URL(target ?? "/", "http://localhost");
  } catch {
    // The URL error text holds the target, so it is not kept.
    throw new HttpError(400, "invalid request target");
  }
}

async function handle(
  ops: Ops,
  now: () => number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = parseTarget(req.url);
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (serveOps(ops, req, res)) return;
  const ping = HEARTBEAT_PATH.exec(path);
  if (ping) return servePing(ops, now, req, res, ping);
  if (isPrivateManualPath(path)) {
    // Before the `/admin/*` delegation, so these routes work also with the config writes off.
    const deps = {
      store: ops.manualIncidents,
      authorize: (r: IncomingMessage, route: string) => requireAdmin(ops, r, route),
      info: ops.info,
      warn: ops.warn,
    };
    return serveManualIncidentRoutes(deps, req, res, url);
  }
  if (path.startsWith("/service/")) {
    // Before the read paths: a service route never falls through to a public read.
    const status = statusPathOf(path);
    if (status === null || status === "admin-settings" || ops.runtime === undefined) {
      throw new HttpError(404, "not found");
    }
    return ops.runtime(req, res, status);
  }
  if (path.startsWith("/admin/")) {
    // Before the admin bootstrap, or without a writer, the routes do not exist.
    if ((await ops.admin?.(req, res)) !== true) throw new HttpError(404, "not found");
    return;
  }
  const manual = MANUAL_PATH.exec(path);
  if (manual) return serveManualIncidents(ops, req, res, url, manual);
  if (path === "/results") {
    if (method !== "POST") throw new HttpError(405, "method not allowed", { Allow: "POST" });
    return postResult(ops, now, req, res);
  }
  if (!isReadPath(path)) throw new HttpError(404, "not found");
  if (method !== "GET") throw new HttpError(405, "method not allowed", { Allow: "GET" });
  serveRead(ops, req, res, url);
}

async function postResult(
  ops: Ops,
  now: () => number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { service } = ops;
  const tokenLocation = requireProbe(ops, req.headers.authorization);
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req, { maxBytes: MAX_BODY });
  } catch (err) {
    throw bodyFailure(err);
  }
  // One lookup per request: validation fetches the check, the type guard reuses it.
  let check: Check | undefined;
  const result = validateResult(parsed, now(), (id) => {
    check = service.findActiveCheck(id);
    return check;
  });
  if (typeof result === "string") throw new HttpError(400, result);
  // Only its ping secret changes a heartbeat check. Checked after auth and validation, so an
  // unauthenticated caller learns nothing about check types.
  if (check?.type === "heartbeat") throw new HttpError(403, "heartbeat checks accept only pings");
  // validateResult maps an omitted or blank location to the default: the token decides then.
  const sent = (parsed as { location?: unknown }).location;
  if (typeof sent === "string" && sent.trim() !== "" && result.location !== tokenLocation) {
    throw new HttpError(403, "location does not match token");
  }
  result.location = tokenLocation;
  let isNew: boolean;
  try {
    isNew = service.ingest(result);
  } catch (err) {
    if (err instanceof UnknownCheckError)
      throw new HttpError(404, `unknown check "${result.checkId}"`);
    throw err;
  }
  // A repeat is answered like the first post but is not counted again.
  if (isNew) ops.metrics.recordResult(result.checkId, result.location, result.latencyMs);
  res.writeHead(204).end();
}

/** The body of a read that takes no query and no path parameter, or undefined for another path. */
function plainRead(ops: Ops, path: string): unknown {
  const { service } = ops;
  switch (path) {
    case "/checks":
      return service.listChecks();
    case "/locations":
      return service.listLocations();
    case "/uptime":
      return service.getUptime();
    case "/latency":
      return service.getLatency();
    case "/components":
      return componentsWithState(
        ops.components(),
        service.listCheckStates(),
        service.getUptime(),
        service.listIncidents("open"),
        service.getSloDays,
      );
    case "/components/uptime":
      return componentsUptime(ops.components(), service.getUptime());
    default:
      return undefined;
  }
}

function serveRead(ops: Ops, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname;
  if (path === "/probe/checks") {
    // Carries headers and bodies exactly as written, so it needs a probe token.
    requireProbe(ops, req.headers.authorization);
    sendJson(res, 200, ops.service.listProbeChecks());
    return;
  }
  const plain = plainRead(ops, path);
  if (plain !== undefined) {
    sendJson(res, 200, plain);
    return;
  }
  sendJson(res, 200, queryRead(ops.service, url));
}

/** The reads that take a query or a check id in the path. */
function queryRead(service: Service, url: URL): unknown {
  const path = url.pathname;
  if (path === "/incidents") return listIncidentsFor(service, url);
  if (path === "/maintenance") {
    const checkId = url.searchParams.get("checkId") ?? undefined;
    if (checkId !== undefined && !service.hasCheck(checkId)) {
      throw new HttpError(404, `unknown check "${checkId}"`);
    }
    return service.listMaintenance(checkId);
  }
  const latencyMatch = LATENCY_PATH.exec(path);
  if (latencyMatch) {
    const latency = service.getCheckLatency(decodeCheckId(latencyMatch[1]));
    if (latency === undefined) throw new HttpError(404, "unknown check");
    return latency;
  }
  const locationMatch = LOCATION_UPTIME_PATH.exec(path);
  if (locationMatch) {
    const uptime = service.getCheckLocationUptime(decodeCheckId(locationMatch[1]));
    if (uptime === undefined) throw new HttpError(404, "unknown check");
    return uptime;
  }
  const id = decodeCheckId(RESULTS_PATH.exec(path)?.[1]);
  const limit = Math.min(
    parseCount(url.searchParams.get("limit"), "limit", 1) ?? DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const before = parseCount(url.searchParams.get("before"), "before", 0);
  if (!service.hasCheck(id)) throw new HttpError(404, `unknown check "${id}"`);
  return service.listResults(id, limit, before);
}

function listIncidentsFor(service: Service, url: URL): unknown {
  const status = url.searchParams.get("status");
  if (status !== null && status !== "open" && status !== "resolved") {
    throw new HttpError(400, 'status must be "open" or "resolved"');
  }
  const limit = parseCount(url.searchParams.get("limit"), "limit", 1);
  const since = parseCount(url.searchParams.get("since"), "since", 0);
  return service.listIncidents(status ?? undefined, {
    limit: Math.min(limit ?? DEFAULT_INCIDENT_LIMIT, MAX_INCIDENT_LIMIT),
    ...(since === undefined ? {} : { since }),
  });
}

export type ApiServerOptions = {
  /** Authenticates every Bearer credential. Without it every credential is unknown (401). */
  tokenStore?: Pick<TokenStore, "authenticate">;
  /** True once admins are bootstrapped (a `token_bootstrap` row). Defaults to false. */
  isAdminEnabled?: boolean;
  now?: () => number;
  /** Counters for `/metrics`; the caller shares it with the service to count incidents. */
  metrics?: Metrics;
  /** A short reason while the API is not ready (`/healthz` answers 503), else undefined. */
  notReadyReason?: () => string | undefined;
  /** Receives unexpected request failures. */
  logError?: (message: string, err: unknown) => void;
  /** Hex SHA-256 of the ping secret per heartbeat check id. Without it every ping is refused. */
  heartbeatDigests?: () => ReadonlyMap<string, string>;
  /** The configured components, served by `/components` and `/components/uptime`. */
  components?: () => readonly Component[];
  /** Store behind `/manual-incidents`. Without it, or before the admin bootstrap, the reads are empty. */
  manualIncidents?: ManualIncidentStore;
  /** Logs and counts failed admin authentications; defaults to one that only counts in `metrics`. */
  adminAuthFailures?: AdminAuthFailures;
  /** Throttles failed admin authentications; defaults to an instance of its own. */
  adminAuthThrottle?: AdminAuthThrottle;
  /** Receives the manual-incident write lines. */
  info?: LogFn;
  /** Receives the failed manual-incident write lines. */
  warn?: LogFn;
  /** Handler of `/admin/*` (see admin-routes.ts). Without it those paths answer 404. */
  admin?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Handler of `/service/*` (see status-settings-routes.ts). Without it those paths answer 404. */
  runtime?: RuntimeHandler;
};

function emptyManualIncidents(): ManualIncidentStore {
  const refuse = (): never => {
    throw new ManualIncidentNotFoundError("manual incidents are not configured");
  };
  return {
    list: () => [],
    get: () => undefined,
    create: refuse,
    addUpdate: refuse,
    resolve: refuse,
    remove: refuse,
    listInternal: () => [],
    getInternal: () => undefined,
    createDraft: refuse,
    editDraft: refuse,
    saveDraftUpdate: refuse,
    discardDraftUpdate: refuse,
    publish: refuse,
    addNote: refuse,
    deleteNote: refuse,
    removeAny: refuse,
    hasOpenIncidentFor: () => false,
    deleteResolvedBefore: () => 0,
  };
}

export function createApiServer(service: Service, options: ApiServerOptions): Server {
  const now = options.now ?? Date.now;
  const metrics = options.metrics ?? createMetrics({ listStates: () => service.listCheckStates() });
  const isAdminEnabled = options.isAdminEnabled ?? false;
  const ignore: LogFn = () => {
    // No logger given: the lines are dropped on purpose.
  };
  const tokens = options.tokenStore ?? { authenticate: () => ({ kind: "unknown" as const }) };
  const ops: Ops = {
    service,
    metrics,
    notReadyReason: options.notReadyReason ?? (() => undefined),
    heartbeatDigests: options.heartbeatDigests ?? (() => new Map()),
    components: options.components ?? (() => []),
    // Before the admin bootstrap the feature is off: every read is empty, even with stored incidents.
    tokens,
    manualIncidents: isAdminEnabled
      ? (options.manualIncidents ?? emptyManualIncidents())
      : emptyManualIncidents(),
    isAdminEnabled,
    authThrottle:
      options.adminAuthThrottle ??
      createAdminAuthThrottle({
        tokens,
        authFailures:
          options.adminAuthFailures ?? createAdminAuthFailures({ now, warn: ignore, metrics }),
        now,
        warn: options.warn ?? ignore,
        metrics,
      }),
    info: options.info ?? ignore,
    warn: options.warn ?? ignore,
    admin: options.admin,
    runtime: options.runtime,
  };
  const logError = options.logError ?? ((_message, err) => console.error(err));
  return createServer((req, res) => {
    res.on("finish", () => {
      // A private route is never counted, whatever its status, so the counter shows no activity.
      if (isPrivateManualTarget(req.url)) return;
      ops.metrics.recordRequest(routeOf(req.url), res.statusCode);
    });
    // Set before any write; writeHead keeps these next to the headers a response adds.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(ops, now, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError || err instanceof ManualRouteError) {
        sendError(res, err.status, err.message, err.headers);
      } else {
        logError("request failed", err);
        sendError(res, 500, "internal error");
      }
    });
  });
}
