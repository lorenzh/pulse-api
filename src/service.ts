import type { DatabaseSync } from "node:sqlite";
import type {
  Check,
  CheckState,
  CheckWithState,
  Incident,
  LocationResult,
  MaintenanceWindow,
  Result,
} from "@lorenzh/pulse-contract";
import { applyResult, quorumStatus } from "./state.ts";

export const DEFAULT_LOCATION = "default";
export const MAX_LOCATION_LENGTH = 64;
/** The quorum window spans this many check intervals before a result. */
const WINDOW_INTERVALS = 2;

export class UnknownCheckError extends Error {}

export interface Service {
  upsertChecks(checks: Check[]): void;
  ingest(result: Result): void;
  listChecks(): CheckWithState[];
  hasCheck(id: string): boolean;
  listResults(checkId: string, limit: number): Result[];
  listIncidents(status?: "open" | "resolved"): Incident[];
  listMaintenance(checkId?: string): MaintenanceWindow[];
}

type Row = Record<string, any>;

export interface ServiceOptions {
  maintenance?: MaintenanceWindow[];
  /** Clock for displayed state and window listings; results are classified by their own timestamp. */
  now?: () => number;
}

export function createService(
  db: DatabaseSync,
  { maintenance = [], now = Date.now }: ServiceOptions = {},
): Service {
  const windows = [...maintenance].sort(
    (a, b) => a.start - b.start || (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0),
  );
  const inWindow = (checkId: string, t: number): boolean =>
    windows.some((w) => w.checkId === checkId && w.start <= t && t < w.end);
  const updateLast = db.prepare(
    "UPDATE checks SET last_result_at = ?, last_reason = ? WHERE id = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO checks (id, name, url, type, host, port, warn_days, interval_ms, timeout_ms, retries, retry_delay_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, type = excluded.type,
      host = excluded.host, port = excluded.port, warn_days = excluded.warn_days,
      interval_ms = excluded.interval_ms, timeout_ms = excluded.timeout_ms,
      retries = excluded.retries, retry_delay_ms = excluded.retry_delay_ms`);
  const getCheck = db.prepare("SELECT * FROM checks WHERE id = ?");
  const insertResult = db.prepare(
    `INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, cert_days_left, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const windowResults = db.prepare(
    `SELECT * FROM results WHERE check_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp DESC, id DESC`,
  );
  const latestPerLocation = db.prepare(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY location ORDER BY timestamp DESC, id DESC) AS rn
       FROM results WHERE check_id = ?
     ) WHERE rn = 1 ORDER BY location`,
  );
  const updateState = db.prepare(
    `UPDATE checks SET state = ?, consecutive_down = ?, last_result_at = ?, last_reason = ? WHERE id = ?`,
  );
  const openIncident = db.prepare(
    "INSERT INTO incidents (check_id, opened_at, resolved_at, reason) VALUES (?, ?, NULL, ?)",
  );
  const resolveIncident = db.prepare(
    "UPDATE incidents SET resolved_at = ? WHERE check_id = ? AND resolved_at IS NULL",
  );
  const hasOpen = db.prepare(
    "SELECT 1 AS x FROM incidents WHERE check_id = ? AND resolved_at IS NULL LIMIT 1",
  );

  /** certDaysLeft is emitted for TLS checks (null when unread) and for any stored value. */
  function toResult(r: Row, tls = false): Result {
    const result: Result = {
      checkId: r.check_id,
      timestamp: r.timestamp,
      status: r.status,
      statusCode: r.status_code,
      latencyMs: r.latency_ms,
      reason: r.reason,
      location: r.location,
      attempts: r.attempts ?? 1,
    };
    if (tls || r.cert_days_left !== null) result.certDaysLeft = r.cert_days_left;
    return result;
  }

  function toCheck(r: Row): CheckWithState {
    const state = {
      state: r.state as CheckState,
      consecutiveDown: r.consecutive_down,
      lastResultAt: r.last_result_at,
      lastReason: r.last_reason,
      locations: [] as LocationResult[],
    };
    const c: CheckWithState =
      r.type === "tls"
        ? {
            id: r.id,
            name: r.name,
            type: "tls",
            host: r.host,
            port: r.port,
            warnDays: r.warn_days,
            intervalMs: r.interval_ms,
            ...state,
          }
        : {
            id: r.id,
            name: r.name,
            url: r.url,
            intervalMs: r.interval_ms,
            retries: r.retries ?? 0,
            retryDelayMs: r.retry_delay_ms ?? 1000,
            ...state,
          };
    if (r.timeout_ms !== null) c.timeoutMs = r.timeout_ms;
    return c;
  }

  function transaction(fn: () => void): void {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    upsertChecks(checks) {
      transaction(() => {
        for (const c of checks) {
          const timeout = c.timeoutMs ?? null;
          if (c.type === "tls") {
            upsert.run(
              c.id,
              c.name,
              "",
              "tls",
              c.host,
              c.port,
              c.warnDays,
              c.intervalMs,
              timeout,
              null,
              null,
            );
          } else {
            upsert.run(
              c.id,
              c.name,
              c.url,
              "http",
              null,
              null,
              null,
              c.intervalMs,
              timeout,
              c.retries ?? 0,
              c.retryDelayMs ?? 1000,
            );
          }
        }
      });
    },

    ingest(result) {
      transaction(() => {
        const row = getCheck.get(result.checkId) as Row | undefined;
        if (!row) throw new UnknownCheckError(result.checkId);
        insertResult.run(
          result.checkId,
          result.timestamp,
          result.status,
          result.statusCode,
          result.latencyMs,
          result.reason,
          result.location,
          result.certDaysLeft ?? null,
          result.attempts ?? 1,
        );
        if (result.status === "down" && inWindow(result.checkId, result.timestamp)) {
          updateLast.run(result.timestamp, result.reason, result.checkId);
          return;
        }
        // Window [T - 2*interval, T]; rows are newest first, so the first row per location is its latest.
        const rows = windowResults.all(
          result.checkId,
          result.timestamp - WINDOW_INTERVALS * row.interval_ms,
          result.timestamp,
        ) as Row[];
        const latest = new Map<string, Row>();
        for (const r of rows) if (!latest.has(r.location)) latest.set(r.location, r);
        const combined = quorumStatus([...latest.values()].map((r) => r.status));
        const latestDown = rows.find((r) => r.status === "down");
        const { next, action } = applyResult(
          {
            state: row.state,
            consecutiveDown: row.consecutive_down,
            incidentOpen: hasOpen.get(result.checkId) !== undefined,
          },
          combined,
        );
        if (action === "open")
          openIncident.run(result.checkId, result.timestamp, latestDown?.reason ?? result.reason);
        if (action === "resolve") resolveIncident.run(result.timestamp, result.checkId);
        updateState.run(
          next.state,
          next.consecutiveDown,
          result.timestamp,
          result.reason,
          result.checkId,
        );
      });
    },

    listChecks() {
      const t = now();
      return (db.prepare("SELECT * FROM checks ORDER BY rowid").all() as Row[]).map((r) => {
        const c = toCheck(r);
        const tls = c.type === "tls";
        const latest = (latestPerLocation.all(c.id) as Row[]).map((l) => toResult(l, tls));
        const newest = Math.max(...latest.map((l) => l.timestamp));
        if (tls) {
          const newestResult = latest.find((l) => l.timestamp === newest);
          c.certDaysLeft = newestResult?.certDaysLeft ?? null;
        }
        c.locations = latest.map(
          (result): LocationResult => ({
            location: result.location,
            result,
            stale: result.timestamp < newest - WINDOW_INTERVALS * c.intervalMs,
          }),
        );
        const active = windows.find((w) => w.checkId === c.id && w.start <= t && t < w.end);
        if (active) {
          c.state = "maintenance";
          c.maintenance = { ...active };
        }
        return c;
      });
    },

    listMaintenance(checkId) {
      const t = now();
      return windows
        .filter((w) => w.end > t && (checkId === undefined || w.checkId === checkId))
        .map((w) => ({ ...w }));
    },

    hasCheck(id) {
      return getCheck.get(id) !== undefined;
    },

    listResults(checkId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM results WHERE check_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?",
        )
        .all(checkId, limit) as Row[];
      const tls = (getCheck.get(checkId) as Row | undefined)?.type === "tls";
      return rows.map((r) => toResult(r, tls));
    },

    listIncidents(status) {
      const where =
        status === "open"
          ? "WHERE resolved_at IS NULL"
          : status === "resolved"
            ? "WHERE resolved_at IS NOT NULL"
            : "";
      const rows = db
        .prepare(
          `SELECT * FROM incidents ${where}
           ORDER BY (resolved_at IS NOT NULL), opened_at DESC, id DESC`,
        )
        .all() as Row[];
      return rows.map((r) => ({
        id: r.id,
        checkId: r.check_id,
        openedAt: r.opened_at,
        resolvedAt: r.resolved_at,
        reason: r.reason,
      }));
    },
  };
}
