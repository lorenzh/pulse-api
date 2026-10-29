import type { DatabaseSync } from "node:sqlite";
import type {
  Check,
  CheckState,
  CheckStatus,
  CheckUptime,
  CheckWithState,
  Incident,
  LocationResult,
  MaintenanceWindow,
  Result,
  UptimeDay,
} from "@lorenzh/pulse-contract";
import { applyResult, DOWNS_TO_OPEN, quorumStatus } from "./state.ts";

export const DEFAULT_LOCATION = "default";
export const MAX_LOCATION_LENGTH = 64;
/** The quorum window spans this many check intervals before a result. */
const WINDOW_INTERVALS = 2;

export const DAY_MS = 86_400_000;
export const UPTIME_DAYS = 90;

export class UnknownCheckError extends Error {}

/** The location of ping results and of the down result the evaluator writes. */
export const HEARTBEAT_LOCATION = "heartbeat";

/** What the heartbeat evaluator needs to judge one active heartbeat check. */
export interface HeartbeatInfo {
  id: string;
  period: number;
  grace: number;
  /** The last ping (the evaluator's own down results do not move it). */
  lastPingAt: number | null;
  /** The stored state, without the maintenance override. */
  state: CheckState;
  isInMaintenance: boolean;
}

export interface Service {
  upsertChecks(checks: Check[]): void;
  ingest(result: Result): void;
  listChecks(): CheckWithState[];
  /** The id and displayed state of every active check, without results. */
  listCheckStates(): { id: string; state: CheckState }[];
  /** Every active heartbeat check, for the evaluator. */
  listHeartbeats(): HeartbeatInfo[];
  hasCheck(id: string): boolean;
  listResults(checkId: string, limit: number): Result[];
  listIncidents(status?: "open" | "resolved"): Incident[];
  listMaintenance(checkId?: string): MaintenanceWindow[];
  getUptime(): CheckUptime[];
  /** Delete up to `limit` results older than `cutoff`, keeping the newest per check and location. Returns the count. */
  deleteExpiredResults(cutoff: number, limit: number): number;
}

/** A row of `checks` as returned by node:sqlite; nullable columns are typed as such. */
interface CheckRow {
  id: string;
  name: string;
  type: string | null;
  url: string;
  host: string;
  port: number;
  warn_days: number;
  interval_ms: number;
  timeout_ms: number | null;
  latency_objective_ms: number | null;
  retries: number | null;
  retry_delay_ms: number | null;
  keyword: string | null;
  period_ms: number | null;
  grace_ms: number | null;
  state: CheckState;
  consecutive_down: number;
  last_result_at: number | null;
  last_reason: string | null;
}

/** A row of `results`. */
interface ResultRow {
  check_id: string;
  timestamp: number;
  status: CheckStatus;
  status_code: number | null;
  latency_ms: number;
  reason: string | null;
  location: string;
  attempts: number | null;
  cert_days_left: number | null;
}

/** A row of `incidents`. */
interface IncidentRow {
  id: number;
  check_id: string;
  opened_at: number;
  resolved_at: number | null;
  reason: string | null;
}

/** A row of the daily uptime query. */
interface DayRow {
  day: number;
  good: number;
  total: number;
}

export interface ServiceOptions {
  maintenance?: MaintenanceWindow[];
  /** Clock for displayed state and window listings; results are classified by their own timestamp. */
  now?: () => number;
  /** Receives one line per incident resolved because its check left the checks file. */
  log?: (line: string) => void;
  /** Called after a transaction commits, once per incident opened or resolved. */
  onIncident?: (event: "opened" | "resolved") => void;
}

export function createService(
  db: DatabaseSync,
  {
    maintenance = [],
    now = Date.now,
    log = () => undefined,
    onIncident = () => undefined,
  }: ServiceOptions = {},
): Service {
  const windows = [...maintenance].sort(
    // eslint-disable-next-line sonarjs/no-nested-conditional -- tie-break comparator reads clearest as one expression; refactor out of scope
    (a, b) => a.start - b.start || (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0),
  );
  const inWindow = (checkId: string, t: number): boolean =>
    windows.some((w) => w.checkId === checkId && w.start <= t && t < w.end);
  const updateLast = db.prepare(
    "UPDATE checks SET last_result_at = ?, last_reason = ? WHERE id = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO checks (id, name, url, type, host, port, warn_days, interval_ms, timeout_ms, latency_objective_ms, retries, retry_delay_ms, keyword, period_ms, grace_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, type = excluded.type,
      host = excluded.host, port = excluded.port, warn_days = excluded.warn_days,
      interval_ms = excluded.interval_ms, timeout_ms = excluded.timeout_ms,
      latency_objective_ms = excluded.latency_objective_ms,
      retries = excluded.retries, retry_delay_ms = excluded.retry_delay_ms,
      keyword = excluded.keyword, period_ms = excluded.period_ms, grace_ms = excluded.grace_ms,
      active = 1`);
  const clearKeywords = db.prepare("UPDATE checks SET keyword = NULL WHERE keyword IS NOT NULL");
  const getCheck = db.prepare("SELECT * FROM checks WHERE id = ?");
  const getActiveCheck = db.prepare("SELECT * FROM checks WHERE id = ? AND active = 1");
  const deactivateAll = db.prepare("UPDATE checks SET active = 0");
  const resolveInactiveIncidents = db.prepare(
    `UPDATE incidents SET resolved_at = MAX(?, opened_at)
     WHERE resolved_at IS NULL AND check_id IN (SELECT id FROM checks WHERE active = 0)`,
  );
  const resetInactiveState = db.prepare(
    "UPDATE checks SET state = 'unknown', consecutive_down = 0 WHERE active = 0 AND (state != 'unknown' OR consecutive_down != 0)",
  );
  const openInactive = db.prepare(
    `SELECT i.check_id AS id FROM incidents i JOIN checks c ON c.id = i.check_id
     WHERE i.resolved_at IS NULL AND c.active = 0`,
  );
  const insertResult = db.prepare(
    `INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, cert_days_left, attempts, late)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const newestStored = db.prepare(
    "SELECT MAX(timestamp) AS t FROM results WHERE check_id = ? AND location = ?",
  );
  const openedAtOf = db.prepare(
    "SELECT opened_at FROM incidents WHERE check_id = ? AND resolved_at IS NULL LIMIT 1",
  );
  // Late rows are excluded: they are history only and never take part in live evaluation.
  const windowResults = db.prepare(
    `SELECT * FROM results WHERE check_id = ? AND timestamp >= ? AND timestamp <= ? AND late = 0
     ORDER BY timestamp DESC, id DESC`,
  );
  const latestPerLocation = db.prepare(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY location ORDER BY timestamp DESC, id DESC) AS rn
       FROM results WHERE check_id = ?
     ) WHERE rn = 1 ORDER BY location`,
  );
  const dailyUptime = db.prepare(
    `SELECT CAST(timestamp / ${DAY_MS} AS INTEGER) AS day,
            SUM(status != 'down') AS good, COUNT(*) AS total
     FROM results WHERE check_id = ? AND timestamp >= ? AND timestamp <= ?
     GROUP BY day`,
  );
  const deleteExpired = db.prepare(
    `DELETE FROM results WHERE id IN (
       SELECT r.id FROM results r
       WHERE r.timestamp < ? AND EXISTS (
         SELECT 1 FROM results n
         WHERE n.check_id = r.check_id AND n.location = r.location
           AND (n.timestamp > r.timestamp OR (n.timestamp = r.timestamp AND n.id > r.id)))
       LIMIT ?)`,
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
  function toResult(r: ResultRow, tls = false): Result {
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

  function toCheck(r: CheckRow): CheckWithState {
    const state = {
      state: r.state as CheckState,
      consecutiveDown: r.consecutive_down,
      lastResultAt: r.last_result_at,
      lastReason: r.last_reason,
      locations: [] as LocationResult[],
    };
    if (r.type === "heartbeat") {
      return {
        id: r.id,
        name: r.name,
        type: "heartbeat",
        period: r.period_ms ?? r.interval_ms,
        grace: r.grace_ms ?? 0,
        ...state,
      };
    }
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
    if (r.latency_objective_ms !== null && c.type !== "tls") {
      c.latencyObjectiveMs = r.latency_objective_ms;
    }
    if (r.keyword !== null && c.type !== "tls") c.keyword = r.keyword;
    return c;
  }

  /** Combined status of the latest result per location in the window [T - 2*interval, T]. */
  function quorumOf(
    row: CheckRow,
    result: Result,
  ): { combined: CheckStatus; downReason: string | null } {
    // Rows are newest first, so the first row per location is its latest.
    const rows = windowResults.all(
      result.checkId,
      result.timestamp - WINDOW_INTERVALS * row.interval_ms,
      result.timestamp,
    ) as unknown as ResultRow[];
    const latest = new Map<string, ResultRow>();
    for (const r of rows) if (!latest.has(r.location)) latest.set(r.location, r);
    return {
      combined: quorumStatus([...latest.values()].map((r) => r.status)),
      downReason: rows.find((r) => r.status === "down")?.reason ?? result.reason,
    };
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
      let resolved = 0;
      transaction(() => {
        // Clear first, then upsert: checks removed from the file lose their keyword without a long NOT IN list.
        clearKeywords.run();
        deactivateAll.run();
        for (const c of checks) {
          if (c.type === "heartbeat") {
            // url and interval_ms are NOT NULL: the period stands in as the interval.
            upsert.run(
              c.id,
              c.name,
              "",
              "heartbeat",
              null,
              null,
              null,
              c.period,
              null,
              null,
              null,
              null,
              null,
              c.period,
              c.grace,
            );
            continue;
          }
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
              null,
              null,
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
              c.latencyObjectiveMs ?? null,
              c.retries ?? 0,
              c.retryDelayMs ?? 1000,
              c.keyword ?? null,
              null,
              null,
            );
          }
        }
        // Removed checks keep their rows and history, but no incident stays open and no stale state survives.
        const closing = openInactive.all() as unknown as { id: string }[];
        resolveInactiveIncidents.run(now());
        resetInactiveState.run();
        for (const { id } of closing) {
          log(`check "${id}" removed from the checks file: incident resolved`);
          resolved += 1;
        }
      });
      for (let i = 0; i < resolved; i++) onIncident("resolved");
    },

    ingest(result) {
      let incidentEvent: "opened" | "resolved" | undefined;
      transaction(() => {
        const row = getActiveCheck.get(result.checkId) as CheckRow | undefined;
        if (!row) throw new UnknownCheckError(result.checkId);
        // Read before the insert, so the new row is not compared with itself.
        const newest = (
          newestStored.get(result.checkId, result.location) as { t: number | null } | undefined
        )?.t;
        const isHeartbeat = row.type === "heartbeat";
        // Heartbeat timestamps come from the api clock, so lateness does not apply.
        const isLate =
          !isHeartbeat && newest !== null && newest !== undefined && result.timestamp < newest;
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
          isLate ? 1 : 0,
        );
        // A late result is history only: it must not rewrite live state or incidents.
        if (isLate) return;
        if (result.status === "down" && inWindow(result.checkId, result.timestamp)) {
          updateLast.run(result.timestamp, result.reason, result.checkId);
          return;
        }
        const { combined, downReason } = isHeartbeat
          ? { combined: result.status, downReason: result.reason }
          : quorumOf(row, result);
        // One source, no quorum: a single down heartbeat result opens the incident.
        const consecutiveDown =
          isHeartbeat && result.status === "down"
            ? Math.max(row.consecutive_down, DOWNS_TO_OPEN - 1)
            : row.consecutive_down;
        const { next, action } = applyResult(
          {
            state: row.state,
            consecutiveDown,
            incidentOpen: hasOpen.get(result.checkId) !== undefined,
          },
          combined,
        );
        if (action === "open") {
          openIncident.run(result.checkId, result.timestamp, downReason);
          incidentEvent = "opened";
        }
        if (action === "resolve") {
          incidentEvent = "resolved";
          // Another location may report an older timestamp: never resolve before the open.
          const opened = openedAtOf.get(result.checkId) as { opened_at: number } | undefined;
          resolveIncident.run(Math.max(result.timestamp, opened?.opened_at ?? 0), result.checkId);
        }
        // For a heartbeat check lastResultAt is the last ping: the evaluator's down result keeps it.
        const keepsPing = isHeartbeat && result.status === "down";
        updateState.run(
          next.state,
          next.consecutiveDown,
          keepsPing ? row.last_result_at : result.timestamp,
          result.reason,
          result.checkId,
        );
      });
      if (incidentEvent !== undefined) onIncident(incidentEvent);
    },

    listCheckStates() {
      const t = now();
      return (
        db
          .prepare("SELECT id, state FROM checks WHERE active = 1 ORDER BY rowid")
          .all() as unknown as {
          id: string;
          state: CheckState;
        }[]
      ).map(({ id, state }) => ({
        id,
        state: windows.some((w) => w.checkId === id && w.start <= t && t < w.end)
          ? "maintenance"
          : state,
      }));
    },

    listChecks() {
      const t = now();
      return (
        db
          .prepare("SELECT * FROM checks WHERE active = 1 ORDER BY rowid")
          .all() as unknown as CheckRow[]
      ).map((r) => {
        const c = toCheck(r);
        const tls = c.type === "tls";
        const intervalMs = c.type === "heartbeat" ? c.period : c.intervalMs;
        const latest = (latestPerLocation.all(c.id) as unknown as ResultRow[]).map((l) =>
          toResult(l, tls),
        );
        const newest = Math.max(...latest.map((l) => l.timestamp));
        if (tls) {
          const newestResult = latest.find((l) => l.timestamp === newest);
          c.certDaysLeft = newestResult?.certDaysLeft ?? null;
        }
        c.locations = latest.map(
          (result): LocationResult => ({
            location: result.location,
            result,
            stale: result.timestamp < newest - WINDOW_INTERVALS * intervalMs,
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

    listHeartbeats() {
      const t = now();
      return (
        db
          .prepare("SELECT * FROM checks WHERE active = 1 AND type = 'heartbeat' ORDER BY rowid")
          .all() as unknown as CheckRow[]
      ).map((r) => ({
        id: r.id,
        period: r.period_ms ?? r.interval_ms,
        grace: r.grace_ms ?? 0,
        lastPingAt: r.last_result_at,
        state: r.state,
        isInMaintenance: inWindow(r.id, t),
      }));
    },

    listMaintenance(checkId) {
      const t = now();
      return windows
        .filter((w) => w.end > t && (checkId === undefined || w.checkId === checkId))
        .map((w) => ({ ...w }));
    },

    getUptime() {
      const t = now();
      const today = Math.floor(t / DAY_MS);
      const firstDay = today - (UPTIME_DAYS - 1);
      const ids = db
        .prepare("SELECT id FROM checks WHERE active = 1 ORDER BY rowid")
        .all() as unknown as Pick<CheckRow, "id">[];
      return ids.map(({ id }): CheckUptime => {
        const byDay = new Map<number, { good: number; total: number }>();
        for (const r of dailyUptime.all(id, firstDay * DAY_MS, t) as unknown as DayRow[]) {
          byDay.set(Number(r.day), { good: Number(r.good), total: Number(r.total) });
        }
        let good = 0;
        let total = 0;
        const days: UptimeDay[] = [];
        for (let d = firstDay; d <= today; d++) {
          const agg = byDay.get(d);
          good += agg?.good ?? 0;
          total += agg?.total ?? 0;
          days.push({
            date: new Date(d * DAY_MS).toISOString().slice(0, 10),
            uptime: agg ? (agg.good / agg.total) * 100 : null,
            results: agg?.total ?? 0,
          });
        }
        return { checkId: id, days, uptime: total === 0 ? null : (good / total) * 100 };
      });
    },

    deleteExpiredResults(cutoff, limit) {
      return Number(deleteExpired.run(cutoff, limit).changes);
    },

    hasCheck(id) {
      return getCheck.get(id) !== undefined;
    },

    listResults(checkId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM results WHERE check_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?",
        )
        .all(checkId, limit) as unknown as ResultRow[];
      const tls = (getCheck.get(checkId) as CheckRow | undefined)?.type === "tls";
      return rows.map((r) => toResult(r, tls));
    },

    listIncidents(status) {
      let where = "";
      if (status === "open") where = "WHERE resolved_at IS NULL";
      else if (status === "resolved") where = "WHERE resolved_at IS NOT NULL";
      const rows = db
        .prepare(
          `SELECT * FROM incidents ${where}
           ORDER BY (resolved_at IS NOT NULL), opened_at DESC, id DESC`,
        )
        .all() as unknown as IncidentRow[];
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
