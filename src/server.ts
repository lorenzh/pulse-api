import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type Check,
  type Component,
  type ErrorResponse,
  MANUAL_INCIDENT_MAX_BODY_BYTES,
  type Result,
  validatePostResultRequest,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { BodyError, handleOps, readBody, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import { componentsUptime, componentsWithState } from "./components.ts";
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
  MAX_LOCATION_LENGTH,
  type Service,
  UnknownCheckError,
} from "./service.ts";
import { authenticate, matchesAnyToken, type ProbeToken } from "./tokens.ts";

const MAX_BODY = 1_000_000;
const MAX_PING_BODY = 1024;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_RESULT_AGE_MS = 7 * 86_400_000;
export const MAX_REASON_LENGTH = 1000;
export const MAX_ATTEMPTS = 100;
export const MAX_LATENCY_MS = 86_400_000;
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

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
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
  if (!isFiniteNumber(b.latencyMs) || b.latencyMs < 0 || b.latencyMs > MAX_LATENCY_MS)
    return `latencyMs must be a number from 0 to ${MAX_LATENCY_MS}`;
  if (b.reason !== null && typeof b.reason !== "string") return "reason must be a string or null";
  if (typeof b.reason === "string" && b.reason.length > MAX_REASON_LENGTH)
    return `reason must be at most ${MAX_REASON_LENGTH} characters`;
  if (
    b.certDaysLeft !== undefined &&
    b.certDaysLeft !== null &&
    !(typeof b.certDaysLeft === "number" && Number.isInteger(b.certDaysLeft))
  ) {
    return "certDaysLeft must be an integer or null";
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

/** Validate a POST /results body against the clock `now` (epoch ms); returns an error message or the Result. */
// eslint-disable-next-line sonarjs/function-return-type -- the result is a deliberate Result-or-message union
export function validateResult(
  body: unknown,
  now: number,
  findCheck: (id: string) => Check | undefined,
): Result | string {
  const shape = validatePostResultRequest(body);
  if (!shape.ok) return shape.error;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
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
const MANUAL_PATH = /^\/manual-incidents(?:\/([^/]+)(?:\/(updates|resolve))?)?$/;
const HEARTBEAT_PATH = /^\/heartbeat\/([^/]+)(?:\/([^/]+))?$/;
const ROUTES = [
  "/results",
  "/checks",
  "/probe/checks",
  "/uptime",
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
  if (HEARTBEAT_PATH.test(path)) return "/heartbeat/:id";
  const manual = MANUAL_PATH.exec(path);
  if (manual?.[1] !== undefined) {
    return manual[2] === undefined ? "/manual-incidents/:id" : `/manual-incidents/:id/${manual[2]}`;
  }
  return ROUTES.find((r) => r === path) ?? "unmatched";
}

type Ops = {
  service: Service;
  metrics: Metrics;
  notReadyReason: () => string | undefined;
  heartbeatSecrets: ReadonlyMap<string, string>;
  components: readonly Component[];
  manualIncidents: ManualIncidentStore;
  /** Admin tokens; undefined when the feature is off and the write routes answer 404. */
  adminTokens: readonly string[] | undefined;
};

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
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
  if (method !== "GET" && method !== "POST") throw new HttpError(405, "method not allowed");
  let id: string | undefined;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch {
    // A malformed escape cannot name a check: it answers like an unknown id.
    id = undefined;
  }
  const expected = id === undefined ? undefined : ops.heartbeatSecrets.get(id);
  const given = pingSecret(match[2], req.headers.authorization);
  // Digests of equal length keep the comparison constant-time; a missing side compares as empty.
  const isValid =
    timingSafeEqual(digest(expected ?? ""), digest(given ?? "")) &&
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

function requireAdmin(ops: Ops, req: IncomingMessage): void {
  // Without admin tokens the feature is off and the write routes do not exist.
  if (ops.adminTokens === undefined) throw new HttpError(404, "not found");
  if (!matchesAnyToken(ops.adminTokens, req.headers.authorization)) {
    throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
  }
}

/** Run a write route; the store's errors map to a status. */
async function writeManual(
  ops: Ops,
  req: IncomingMessage,
  res: ServerResponse,
  action: ManualAction,
  id: number,
): Promise<void> {
  const store = ops.manualIncidents;
  try {
    if (action === "update") {
      sendJson(res, 201, store.addUpdate(id, await readManualBody(req, false)));
    } else if (action === "resolve") {
      sendJson(res, 200, store.resolve(id, await readManualBody(req, true)));
    } else {
      store.remove(id);
      res.writeHead(204).end();
    }
  } catch (err) {
    throw manualFailure(err);
  }
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
  requireAdmin(ops, req);
  if (action === "create") {
    try {
      sendJson(res, 201, store.create(await readManualBody(req, false)));
    } catch (err) {
      throw manualFailure(err);
    }
    return;
  }
  if (id !== undefined) await writeManual(ops, req, res, action, id);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- splitting this validator/handler would be a behaviour-risking refactor
async function handle(
  ops: Ops,
  tokens: readonly ProbeToken[],
  now: () => number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { service } = ops;
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (serveOps(ops, req, res)) return;
  const ping = HEARTBEAT_PATH.exec(path);
  if (ping) return servePing(ops, now, req, res, ping);
  const manual = MANUAL_PATH.exec(path);
  if (manual) return serveManualIncidents(ops, req, res, url, manual);
  const known =
    path === "/results" ||
    path === "/checks" ||
    path === "/probe/checks" ||
    path === "/uptime" ||
    path === "/components" ||
    path === "/components/uptime" ||
    path === "/incidents" ||
    path === "/locations" ||
    path === "/maintenance" ||
    RESULTS_PATH.test(path);
  if (!known) throw new HttpError(404, "not found");

  if (path === "/results") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    const tokenLocation = authenticate(tokens, req.headers.authorization);
    if (tokenLocation === undefined) {
      throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
    }
    let parsed: unknown;
    try {
      parsed = await readJsonBody(req, { maxBytes: MAX_BODY });
    } catch (err) {
      throw bodyFailure(err);
    }
    const result = validateResult(parsed, now(), (id) => service.findActiveCheck(id));
    if (typeof result === "string") throw new HttpError(400, result);
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
    return;
  }

  if (method !== "GET") throw new HttpError(405, "method not allowed");

  if (path === "/probe/checks") {
    // Carries headers and bodies exactly as written, so it needs a probe token.
    if (authenticate(tokens, req.headers.authorization) === undefined) {
      throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
    }
    sendJson(res, 200, service.listProbeChecks());
    return;
  }

  if (path === "/checks") {
    sendJson(res, 200, service.listChecks());
    return;
  }

  if (path === "/locations") {
    sendJson(res, 200, service.listLocations());
    return;
  }

  if (path === "/uptime") {
    sendJson(res, 200, service.getUptime());
    return;
  }

  if (path === "/components") {
    const openIncidents = service.listIncidents("open");
    sendJson(
      res,
      200,
      componentsWithState(
        ops.components,
        service.listCheckStates(),
        service.getUptime(),
        openIncidents,
      ),
    );
    return;
  }

  if (path === "/components/uptime") {
    sendJson(res, 200, componentsUptime(ops.components, service.getUptime()));
    return;
  }

  if (path === "/incidents") {
    const status = url.searchParams.get("status");
    if (status !== null && status !== "open" && status !== "resolved") {
      throw new HttpError(400, 'status must be "open" or "resolved"');
    }
    const limit = parseCount(url.searchParams.get("limit"), "limit", 1);
    const since = parseCount(url.searchParams.get("since"), "since", 0);
    sendJson(
      res,
      200,
      service.listIncidents(status ?? undefined, {
        limit: Math.min(limit ?? DEFAULT_INCIDENT_LIMIT, MAX_INCIDENT_LIMIT),
        ...(since === undefined ? {} : { since }),
      }),
    );
    return;
  }

  if (path === "/maintenance") {
    const checkId = url.searchParams.get("checkId") ?? undefined;
    if (checkId !== undefined && !service.hasCheck(checkId)) {
      throw new HttpError(404, `unknown check "${checkId}"`);
    }
    sendJson(res, 200, service.listMaintenance(checkId));
    return;
  }

  let id: string;
  try {
    const encoded = RESULTS_PATH.exec(path)?.[1];
    if (encoded === undefined) throw new HttpError(400, "bad check id");
    id = decodeURIComponent(encoded);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // decodeURIComponent throws URIError on malformed escapes: report it as a bad id
    throw new HttpError(400, "bad check id");
  }
  const limit = Math.min(
    parseCount(url.searchParams.get("limit"), "limit", 1) ?? DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const before = parseCount(url.searchParams.get("before"), "before", 0);
  if (!service.hasCheck(id)) throw new HttpError(404, `unknown check "${id}"`);
  sendJson(res, 200, service.listResults(id, limit, before));
}

export type ApiServerOptions = {
  tokens: readonly ProbeToken[];
  now?: () => number;
  /** Counters for `/metrics`; the caller shares it with the service to count incidents. */
  metrics?: Metrics;
  /** A short reason while the API is not ready (`/healthz` answers 503), else undefined. */
  notReadyReason?: () => string | undefined;
  /** Receives unexpected request failures. */
  logError?: (message: string, err: unknown) => void;
  /** Ping secret per heartbeat check id. Without it every ping is refused. */
  heartbeatSecrets?: ReadonlyMap<string, string>;
  /** The configured components, served by `/components` and `/components/uptime`. */
  components?: readonly Component[];
  /** Store behind `/manual-incidents`. Without it, or without `adminTokens`, the reads are empty. */
  manualIncidents?: ManualIncidentStore;
  /** Tokens that may write manual incidents. Without them the writes answer 404 and the reads are empty. */
  adminTokens?: readonly string[];
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
    deleteResolvedBefore: () => 0,
  };
}

export function createApiServer(service: Service, options: ApiServerOptions): Server {
  const now = options.now ?? Date.now;
  const ops: Ops = {
    service,
    metrics: options.metrics ?? createMetrics({ listStates: () => service.listCheckStates() }),
    notReadyReason: options.notReadyReason ?? (() => undefined),
    heartbeatSecrets: options.heartbeatSecrets ?? new Map(),
    components: options.components ?? [],
    // Without admin tokens the feature is off: every read is empty, even with stored incidents.
    manualIncidents:
      options.adminTokens === undefined
        ? emptyManualIncidents()
        : (options.manualIncidents ?? emptyManualIncidents()),
    adminTokens: options.adminTokens,
  };
  const logError = options.logError ?? ((_message, err) => console.error(err));
  return createServer((req, res) => {
    res.on("finish", () => ops.metrics.recordRequest(routeOf(req.url), res.statusCode));
    // Set before any write; writeHead keeps these next to the headers a response adds.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(ops, options.tokens, now, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message, err.headers);
      } else {
        logError("request failed", err);
        sendError(res, 500, "internal error");
      }
    });
  });
}
