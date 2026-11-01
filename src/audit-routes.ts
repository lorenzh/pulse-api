import type { ServerResponse } from "node:http";
import {
  AUDIT_ACTIONS,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_EXPORT_CONTENT_TYPE,
  AUDIT_MAX_LIMIT,
  AUDIT_TARGET_KINDS,
  type AuditAction,
  type AuditEntry,
  type AuditTargetKind,
} from "@lorenzh/pulse-contract";
import { sendJson } from "@lorenzh/pulse-kit";
import type { AuditFilter, AuditLog, AuditPageQuery } from "./audit-log.ts";

export type AuditPath = "query" | "export";

/** `/admin/audit` or `/admin/audit/export`; null for any other path. */
export function auditPathOf(path: string): AuditPath | null {
  if (path === "/admin/audit") return "query";
  return path === "/admin/audit/export" ? "export" : null;
}

/** The route pattern of the request metric. */
export function auditRouteOf(path: AuditPath): string {
  return path === "query" ? "/admin/audit" : "/admin/audit/export";
}

/** A query parameter that is unknown, repeated or malformed. The message names only the key. */
export class AuditQueryError extends Error {
  override name = "AuditQueryError";
}

const FILTER_KEYS = ["actor", "action", "targetKind", "targetId", "since", "until"] as const;
const PAGE_KEYS = ["limit", "before"] as const;
const ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const KINDS: ReadonlySet<string> = new Set(AUDIT_TARGET_KINDS);

function integer(key: string, raw: string, min: number, max: number): number {
  if (!/^\d{1,16}$/.test(raw)) throw new AuditQueryError(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuditQueryError(`${key} is out of range`);
  }
  return value;
}

function text(key: string, raw: string): string {
  if (raw.length === 0) throw new AuditQueryError(`${key} must not be empty`);
  return raw;
}

function single(params: URLSearchParams, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw new AuditQueryError(`unknown query parameter ${key}`);
    if (out.has(key)) throw new AuditQueryError(`${key} is given more than once`);
    out.set(key, value);
  }
  return out;
}

function filterOf(values: Map<string, string>): AuditFilter {
  const filter: AuditFilter = {};
  const actor = values.get("actor");
  if (actor !== undefined) filter.actor = text("actor", actor);
  const action = values.get("action");
  if (action !== undefined) {
    if (!ACTIONS.has(action)) throw new AuditQueryError("action is not a known action");
    filter.action = action as AuditAction;
  }
  const kind = values.get("targetKind");
  if (kind !== undefined) {
    if (!KINDS.has(kind)) throw new AuditQueryError("targetKind is not a known kind");
    filter.targetKind = kind as AuditTargetKind;
  }
  const targetId = values.get("targetId");
  if (targetId !== undefined) filter.targetId = text("targetId", targetId);
  const since = values.get("since");
  if (since !== undefined) filter.since = integer("since", since, 0, Number.MAX_SAFE_INTEGER);
  const until = values.get("until");
  if (until !== undefined) filter.until = integer("until", until, 0, Number.MAX_SAFE_INTEGER);
  if (filter.since !== undefined && filter.until !== undefined && filter.since >= filter.until) {
    throw new AuditQueryError("since must be before until");
  }
  return filter;
}

/** The D9 parameters of `GET /admin/audit`. */
function auditPageQueryOf(params: URLSearchParams): AuditPageQuery {
  const values = single(params, [...FILTER_KEYS, ...PAGE_KEYS]);
  const query: AuditPageQuery = { ...filterOf(values), limit: AUDIT_DEFAULT_LIMIT };
  const limit = values.get("limit");
  if (limit !== undefined) query.limit = integer("limit", limit, 1, AUDIT_MAX_LIMIT);
  const before = values.get("before");
  if (before !== undefined) query.before = integer("before", before, 1, Number.MAX_SAFE_INTEGER);
  return query;
}

/** The D9 filters of `GET /admin/audit/export`; `limit` and `before` are refused. */
function auditExportFilterOf(params: URLSearchParams): AuditFilter {
  return filterOf(single(params, FILTER_KEYS));
}

/** The part of a response that the export writes to. */
export interface ExportSink {
  write(chunk: string): boolean;
  end(): unknown;
  once(event: "drain" | "close", listener: () => void): unknown;
  readonly destroyed: boolean;
}

function drained(sink: ExportSink): Promise<void> {
  return new Promise((resolve) => {
    sink.once("drain", resolve);
    sink.once("close", resolve);
  });
}

/**
 * Write each batch as NDJSON. When `write` reports a full buffer, wait for `drain`
 * before reading the next batch, so memory stays bounded by one batch.
 */
export async function writeAuditExport(
  batches: Iterable<readonly AuditEntry[]>,
  sink: ExportSink,
): Promise<void> {
  for (const batch of batches) {
    const isFull = !sink.write(batch.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    if (isFull) await drained(sink);
    // A closed client stops the walk before the next batch is read.
    if (sink.destroyed) return;
  }
  sink.end();
}

/** Answer an authorized audit request. The caller has set `cache-control: no-store`. */
export async function serveAudit(
  log: AuditLog,
  res: ServerResponse,
  path: AuditPath,
  params: URLSearchParams,
): Promise<void> {
  if (path === "query") {
    sendJson(res, 200, log.query(auditPageQueryOf(params)));
    return;
  }
  const filter = auditExportFilterOf(params);
  res.writeHead(200, { "content-type": `${AUDIT_EXPORT_CONTENT_TYPE}; charset=utf-8` });
  await writeAuditExport(log.batches(filter), res);
}
