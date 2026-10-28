import type { DatabaseSync } from "node:sqlite";
import type {
  Check,
  CheckState,
  CheckWithState,
  Incident,
  MaintenanceWindow,
  Result,
} from "@lorenzh/pulse-contract";
import { applyResult } from "./state.ts";

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
    INSERT INTO checks (id, name, url, interval_ms, timeout_ms) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url,
      interval_ms = excluded.interval_ms, timeout_ms = excluded.timeout_ms`);
  const getCheck = db.prepare("SELECT * FROM checks WHERE id = ?");
  const insertResult = db.prepare(
    `INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
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

  function toCheck(r: Row): CheckWithState {
    const c: CheckWithState = {
      id: r.id,
      name: r.name,
      url: r.url,
      intervalMs: r.interval_ms,
      state: r.state as CheckState,
      consecutiveDown: r.consecutive_down,
      lastResultAt: r.last_result_at,
      lastReason: r.last_reason,
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
        for (const c of checks) upsert.run(c.id, c.name, c.url, c.intervalMs, c.timeoutMs ?? null);
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
        );
        if (result.status === "down" && inWindow(result.checkId, result.timestamp)) {
          updateLast.run(result.timestamp, result.reason, result.checkId);
          return;
        }
        const { next, action } = applyResult(
          {
            state: row.state,
            consecutiveDown: row.consecutive_down,
            incidentOpen: hasOpen.get(result.checkId) !== undefined,
          },
          result.status,
        );
        if (action === "open") openIncident.run(result.checkId, result.timestamp, result.reason);
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
      return rows.map((r) => ({
        checkId: r.check_id,
        timestamp: r.timestamp,
        status: r.status,
        statusCode: r.status_code,
        latencyMs: r.latency_ms,
        reason: r.reason,
      }));
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
