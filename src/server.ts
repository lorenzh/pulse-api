import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type Check,
  type ErrorResponse,
  type Result,
  validatePostResultRequest,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { createMetrics, type Metrics } from "./metrics.ts";
import {
  DEFAULT_LOCATION,
  HEARTBEAT_LOCATION,
  MAX_LOCATION_LENGTH,
  type Service,
  UnknownCheckError,
} from "./service.ts";
import { authenticate, type ProbeToken } from "./tokens.ts";

const MAX_BODY = 1_000_000;
const MAX_PING_BODY = 1024;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_RESULT_AGE_MS = 7 * 86_400_000;
export const MAX_REASON_LENGTH = 1000;
export const MAX_ATTEMPTS = 100;
export const MAX_LATENCY_MS = 86_400_000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

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

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
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

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
const HEARTBEAT_PATH = /^\/heartbeat\/([^/]+)(?:\/([^/]+))?$/;
const ROUTES = [
  "/results",
  "/checks",
  "/uptime",
  "/incidents",
  "/maintenance",
  "/healthz",
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
  return ROUTES.find((r) => r === path) ?? "unmatched";
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain"): void {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

type Ops = {
  service: Service;
  metrics: Metrics;
  notReadyReason: () => string | undefined;
  heartbeatSecrets: ReadonlyMap<string, string>;
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
  await readBody(req, MAX_PING_BODY);
  try {
    ops.service.ingest({
      checkId: id,
      timestamp: now(),
      status: "up",
      statusCode: null,
      latencyMs: 0,
      reason: null,
      location: HEARTBEAT_LOCATION,
      attempts: 1,
    });
    ops.metrics.recordHeartbeatPing(id);
  } catch (err) {
    // An inactive check records nothing, but the job keeps working.
    if (!(err instanceof UnknownCheckError)) throw err;
  }
  res.writeHead(204).end();
}

/** Serve `/healthz` and `/metrics`. Returns false for any other path. Neither needs auth. */
function serveOps(ops: Ops, path: string, method: string, res: ServerResponse): boolean {
  if (path !== "/healthz" && path !== "/metrics") return false;
  if (method !== "GET") throw new HttpError(405, "method not allowed");
  if (path === "/metrics") {
    sendText(
      res,
      200,
      ops.metrics.render(ops.service.listCheckStates()),
      "text/plain; version=0.0.4",
    );
    return true;
  }
  const reason = ops.notReadyReason();
  if (reason === undefined) sendText(res, 200, "ok\n");
  else sendText(res, 503, `${reason}\n`);
  return true;
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
  if (serveOps(ops, path, method, res)) return;
  const ping = HEARTBEAT_PATH.exec(path);
  if (ping) return servePing(ops, now, req, res, ping);
  const known =
    path === "/results" ||
    path === "/checks" ||
    path === "/uptime" ||
    path === "/incidents" ||
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
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "body is not valid JSON");
    }
    const result = validateResult(parsed, now(), (id) =>
      service.listChecks().find((c) => c.id === id),
    );
    if (typeof result === "string") throw new HttpError(400, result);
    // validateResult maps an omitted or blank location to the default: the token decides then.
    const sent = (parsed as { location?: unknown }).location;
    if (typeof sent === "string" && sent.trim() !== "" && result.location !== tokenLocation) {
      throw new HttpError(403, "location does not match token");
    }
    result.location = tokenLocation;
    try {
      service.ingest(result);
    } catch (err) {
      if (err instanceof UnknownCheckError)
        throw new HttpError(404, `unknown check "${result.checkId}"`);
      throw err;
    }
    ops.metrics.recordResult(result.checkId, result.location, result.latencyMs);
    res.writeHead(204).end();
    return;
  }

  if (method !== "GET") throw new HttpError(405, "method not allowed");

  if (path === "/checks") {
    sendJson(res, 200, service.listChecks());
    return;
  }

  if (path === "/uptime") {
    sendJson(res, 200, service.getUptime());
    return;
  }

  if (path === "/incidents") {
    const status = url.searchParams.get("status");
    if (status !== null && status !== "open" && status !== "resolved") {
      throw new HttpError(400, 'status must be "open" or "resolved"');
    }
    sendJson(res, 200, service.listIncidents(status ?? undefined));
    return;
  }

  if (path === "/maintenance") {
    sendJson(res, 200, service.listMaintenance(url.searchParams.get("checkId") ?? undefined));
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
  let limit = DEFAULT_LIMIT;
  const raw = url.searchParams.get("limit");
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1)
      throw new HttpError(400, "limit must be a positive integer");
    limit = Math.min(Number(raw), MAX_LIMIT);
  }
  if (!service.hasCheck(id)) throw new HttpError(404, `unknown check "${id}"`);
  sendJson(res, 200, service.listResults(id, limit));
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
};

export function createApiServer(service: Service, options: ApiServerOptions): Server {
  const now = options.now ?? Date.now;
  const ops: Ops = {
    service,
    metrics: options.metrics ?? createMetrics(),
    notReadyReason: options.notReadyReason ?? (() => undefined),
    heartbeatSecrets: options.heartbeatSecrets ?? new Map(),
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
