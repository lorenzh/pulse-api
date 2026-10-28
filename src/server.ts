import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ErrorResponse, Result } from "@lorenzh/pulse-contract";
import {
  DEFAULT_LOCATION,
  MAX_LOCATION_LENGTH,
  type Service,
  UnknownCheckError,
} from "./service.ts";

const MAX_BODY = 1_000_000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  const body: ErrorResponse = { error };
  sendJson(res, status, body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a POST /results body; returns an error message or the Result. */
export function validateResult(body: unknown): Result | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  if (typeof b.checkId !== "string" || b.checkId === "")
    return "checkId must be a non-empty string";
  if (!isFiniteNumber(b.timestamp)) return "timestamp must be a number";
  if (b.status !== "up" && b.status !== "down") return 'status must be "up" or "down"';
  if (
    b.statusCode !== null &&
    !(typeof b.statusCode === "number" && Number.isInteger(b.statusCode))
  ) {
    return "statusCode must be an integer or null";
  }
  if (!isFiniteNumber(b.latencyMs) || b.latencyMs < 0)
    return "latencyMs must be a non-negative number";
  if (b.reason !== null && typeof b.reason !== "string") return "reason must be a string or null";
  let location = DEFAULT_LOCATION;
  if (b.location !== undefined) {
    if (typeof b.location !== "string") return "location must be a string";
    const trimmed = b.location.trim();
    if (trimmed.length > MAX_LOCATION_LENGTH)
      return `location must be at most ${MAX_LOCATION_LENGTH} characters`;
    if (trimmed !== "") location = trimmed;
  }
  return {
    checkId: b.checkId,
    timestamp: b.timestamp,
    status: b.status,
    statusCode: b.statusCode,
    latencyMs: b.latencyMs,
    reason: b.reason,
    location,
  };
}

const RESULTS_PATH = /^\/checks\/([^/]+)\/results$/;

async function handle(service: Service, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const known =
    path === "/results" ||
    path === "/checks" ||
    path === "/incidents" ||
    path === "/maintenance" ||
    RESULTS_PATH.test(path);
  if (!known) throw new HttpError(404, "not found");

  if (path === "/results") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "body is not valid JSON");
    }
    const result = validateResult(parsed);
    if (typeof result === "string") throw new HttpError(400, result);
    try {
      service.ingest(result);
    } catch (err) {
      if (err instanceof UnknownCheckError)
        throw new HttpError(404, `unknown check "${result.checkId}"`);
      throw err;
    }
    res.writeHead(204).end();
    return;
  }

  if (method !== "GET") throw new HttpError(405, "method not allowed");

  if (path === "/checks") {
    sendJson(res, 200, service.listChecks());
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
    id = decodeURIComponent(RESULTS_PATH.exec(path)![1]!);
  } catch {
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

export function createApiServer(service: Service): Server {
  return createServer((req, res) => {
    handle(service, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
      } else {
        console.error(err);
        sendError(res, 500, "internal error");
      }
    });
  });
}
