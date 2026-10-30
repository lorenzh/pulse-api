import type { Database } from "bun:sqlite";
import type {
  Check,
  CheckState,
  CheckStateFields,
  CheckStatus,
  CheckUptime,
  CheckWithState,
  HttpCheck,
  Incident,
  Location,
  LocationResult,
  MaintenanceWindow,
  Result,
  UptimeDay,
} from "@lorenzh/pulse-contract";
import {
  dnsRecordTypeSchema,
  expectedStatusSchema,
  headerValueSchema,
  httpMethodSchema,
  jsonAssertSchema,
} from "@lorenzh/pulse-contract";
import { z } from "zod";
import { applyResult, DOWNS_TO_OPEN, quorumStatus } from "./state.ts";

export const DEFAULT_LOCATION = "default";
export const MAX_LOCATION_LENGTH = 64;
/** The quorum window spans this many check intervals before a result. */
const WINDOW_INTERVALS = 2;

const HEADERS_COLUMN = z.record(z.string(), headerValueSchema);
const DNS_EXPECTED_COLUMN = z.array(z.string());
const JSON_ASSERT_COLUMN = z.array(jsonAssertSchema);
const STATE_KEYS = [
  "state",
  "consecutiveDown",
  "lastResultAt",
  "lastReason",
  "locations",
  "maintenance",
  "certDaysLeft",
] as const;
/** The status list that means "any 2xx": the public list leaves it out. */
const DEFAULT_EXPECTED_STATUS = '["200-299"]';

/** JSON text for a column, or null when the option is not set. */
function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** A JSON column that the api wrote itself; undefined when it is empty or no longer valid. */
function readColumn<T>(schema: z.ZodType<T>, text: string | null): T | undefined {
  if (text === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Unreadable text is treated as not set.
    return undefined;
  }
}

/**
 * Add the request options of a row. The public listing carries a non-default `method` and
 * `expectedStatus` only; the probe listing (`isFull`) carries everything as written.
 */
function addRequestOptions(c: HttpCheck, r: CheckRow, isFull: boolean): void {
  const method = httpMethodSchema.safeParse(r.method);
  if (method.success && (isFull || method.data !== "GET")) c.method = method.data;
  const isDefaultStatus = r.expected_status_json === DEFAULT_EXPECTED_STATUS;
  const expectedStatus = readColumn(expectedStatusSchema, r.expected_status_json);
  if (expectedStatus !== undefined && (isFull || !isDefaultStatus)) {
    c.expectedStatus = expectedStatus;
  }
  if (!isFull) return;
  const headers = readColumn(HEADERS_COLUMN, r.headers_json);
  if (headers !== undefined) c.headers = headers;
  if (r.body !== null) c.body = r.body;
  const jsonAssert = readColumn(JSON_ASSERT_COLUMN, r.json_assert_json);
  if (jsonAssert !== undefined) c.jsonAssert = jsonAssert;
}

export const DAY_MS = 86_400_000;
export const UPTIME_DAYS = 90;
/** How long `listChecks` and `getUptime` answers are reused when no ingest happened. */
export const CACHE_TTL_MS = 5000;

/** The lowest default for the silent threshold of a location. */
export const MIN_LOCATION_SILENT_MS = 180_000;

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

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
  /**
   * Store a result. Idempotent on (check, location, timestamp): a repeat changes nothing and
   * returns false; a new result returns true.
   */
  ingest(result: Result): boolean;
  /** Every probe location seen, sorted by name, with its state at the current time. */
  listLocations(): Location[];
  listChecks(): CheckWithState[];
  /** Every active check as written in the checks file, for an authenticated probe. No state. */
  listProbeChecks(): Check[];
  /** The id and displayed state of every active check, without results. */
  listCheckStates(): { id: string; state: CheckState }[];
  /** Every active heartbeat check, for the evaluator. */
  listHeartbeats(): HeartbeatInfo[];
  hasCheck(id: string): boolean;
  /** One active check by id, without its results; undefined when unknown or inactive. */
  findActiveCheck(id: string): Check | undefined;
  /**
   * Newest first. `before` (epoch ms, exclusive) is the paging cursor. A page that ends inside a
   * group of equal timestamps (several locations) also returns the rest of that group.
   */
  listResults(checkId: string, limit: number, before?: number): Result[];
  /** Open first, then newest opened first. `since` keeps incidents open or touched at or after it. */
  listIncidents(
    status?: "open" | "resolved",
    opts?: { limit?: number; since?: number },
  ): Incident[];
  listMaintenance(checkId?: string): MaintenanceWindow[];
  getUptime(): CheckUptime[];
  /** True when the database answers a trivial query. */
  isDbReady(): boolean;
  /** Delete up to `limit` results older than `cutoff`, keeping the newest per check and location. Returns the count. */
  deleteExpiredResults(cutoff: number, limit: number): number;
}

/** A row of `checks` as returned by bun:sqlite; nullable columns are typed as such. */
interface CheckRow {
  id: string;
  name: string;
  type: string | null;
  url: string | null;
  host: string | null;
  port: number | null;
  warn_days: number | null;
  interval_ms: number;
  timeout_ms: number | null;
  latency_objective_ms: number | null;
  retries: number | null;
  retry_delay_ms: number | null;
  keyword: string | null;
  method: string | null;
  headers_json: string | null;
  body: string | null;
  expected_status_json: string | null;
  json_assert_json: string | null;
  period_ms: number | null;
  grace_ms: number | null;
  dns_name: string | null;
  record_type: string | null;
  expected_json: string | null;
  resolver: string | null;
  domain: string | null;
  state: CheckState;
  consecutive_down: number;
  last_result_at: number | null;
  last_reason: string | null;
}

/** A row of `results`. */
interface ResultRow {
  check_id: string;
  id: number;
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
  /** `PULSE_LOCATION_SILENT_MS`; without it the threshold follows the check intervals. */
  locationSilentMs?: number;
  /** Called after a transaction commits, once per incident opened or resolved. */
  onIncident?: (event: "opened" | "resolved") => void;
}

/** TLS and domain checks report `certDaysLeft`. */
function hasDaysLeft(type: string | null | undefined): boolean {
  return type === "tls" || type === "domain";
}

type Column = string | number | null;

/** The values of one `checks` row in the column order of the upsert; columns of other types are NULL. */
function columnsOf(c: Check): Column[] {
  const row: Record<string, Column> = {
    id: c.id,
    name: c.name,
    url: null,
    type: c.type ?? "http",
    host: null,
    port: null,
    warn_days: null,
    interval_ms: 0,
    timeout_ms: null,
    latency_objective_ms: null,
    retries: null,
    retry_delay_ms: null,
    keyword: null,
    period_ms: null,
    grace_ms: null,
    method: null,
    headers_json: null,
    body: null,
    expected_status_json: null,
    json_assert_json: null,
    dns_name: null,
    record_type: null,
    expected_json: null,
    resolver: null,
    domain: null,
  };
  if (c.type === "heartbeat") {
    // interval_ms is NOT NULL: the period stands in as the interval; url is empty as it always was.
    row.url = "";
    row.interval_ms = c.period;
    row.period_ms = c.period;
    row.grace_ms = c.grace;
    return Object.values(row);
  }
  row.interval_ms = c.intervalMs;
  row.timeout_ms = c.timeoutMs ?? null;
  if (c.type === "tls") {
    row.url = "";
    row.host = c.host;
    row.port = c.port;
    row.warn_days = c.warnDays;
  } else if (c.type === "tcp") {
    row.host = c.host;
    row.port = c.port;
  } else if (c.type === "dns") {
    row.dns_name = c.dnsName;
    row.record_type = c.recordType;
    row.expected_json = jsonOrNull(c.expected);
    row.resolver = c.resolver ?? null;
  } else if (c.type === "domain") {
    row.domain = c.domain;
    row.warn_days = c.warnDays;
  } else {
    row.url = c.url;
    row.latency_objective_ms = c.latencyObjectiveMs ?? null;
    row.keyword = c.keyword ?? null;
    row.method = c.method ?? null;
    row.headers_json = jsonOrNull(c.headers);
    row.body = c.body ?? null;
    row.expected_status_json = jsonOrNull(c.expectedStatus);
    row.json_assert_json = jsonOrNull(c.jsonAssert);
  }
  if (c.type !== "tls") {
    row.retries = c.retries ?? 0;
    row.retry_delay_ms = c.retryDelayMs ?? 1000;
  }
  return Object.values(row);
}

export function createService(
  db: Database,
  {
    maintenance = [],
    now = Date.now,
    log = () => undefined,
    onIncident = () => undefined,
    locationSilentMs,
  }: ServiceOptions = {},
): Service {
  const windows = [...maintenance].sort(
    // eslint-disable-next-line sonarjs/no-nested-conditional -- tie-break comparator reads clearest as one expression; refactor out of scope
    (a, b) => a.start - b.start || (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0),
  );
  // Per probe location: the newest result timestamp and the api time of the last accepted result.
  // Replayed results carry old timestamps, so `lastSeenAt` decides the state. Rebuilt from the
  // stored results, so a restart does not forget a location.
  const tracker = new Map<string, { lastResultAt: number; lastSeenAt: number }>();
  const trackLocation = (location: string, timestamp: number): void => {
    if (location === HEARTBEAT_LOCATION) return;
    const seen = tracker.get(location);
    tracker.set(location, {
      lastResultAt: Math.max(seen?.lastResultAt ?? 0, timestamp),
      lastSeenAt: now(),
    });
  };
  const silentThreshold = (): number => {
    if (locationSilentMs !== undefined) return locationSilentMs;
    const largest = (largestInterval.get() as { m: number | null } | undefined)?.m ?? 0;
    return Math.max(MIN_LOCATION_SILENT_MS, 3 * largest);
  };
  /** Insert one result row; false when the (check, location, timestamp) sample is stored already. */
  const storeSample = (result: Result, isLate: boolean, isHeartbeat: boolean): boolean => {
    let at = result.timestamp;
    let changes = 0;
    do {
      changes = insertResult.run(
        result.checkId,
        at,
        result.status,
        result.statusCode,
        result.latencyMs,
        result.reason,
        result.location,
        result.certDaysLeft ?? null,
        result.attempts ?? 1,
        isLate ? 1 : 0,
      ).changes;
      // Heartbeat samples are made here, never re-sent: two in one millisecond are both kept.
      at += 1;
    } while (changes === 0 && isHeartbeat);
    return changes > 0;
  };
  let cache = new Map<"checks" | "uptime", { at: number; windows: string; value: unknown }>();
  const invalidate = (): void => {
    cache = new Map();
  };
  /** Reuse a fresh answer; an ingest, a config change or a retention delete clears all of them. */
  function cached<T>(key: "checks" | "uptime", compute: () => T): T {
    const hit = cache.get(key);
    const t = now();
    // A window that opens or closes changes the displayed state, so it also ends a cached answer.
    const active = windows
      .filter((w) => w.start <= t && t < w.end)
      .map((w) => `${w.checkId}@${w.start}`)
      .join("|");
    if (hit !== undefined && hit.windows === active && t >= hit.at && t - hit.at < CACHE_TTL_MS) {
      return hit.value as T;
    }
    const value = compute();
    cache.set(key, { at: t, windows: active, value });
    return value;
  }
  const inWindow = (checkId: string, t: number): boolean =>
    windows.some((w) => w.checkId === checkId && w.start <= t && t < w.end);
  const updateLast = db.prepare(
    "UPDATE checks SET last_result_at = ?, last_reason = ? WHERE id = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO checks (id, name, url, type, host, port, warn_days, interval_ms, timeout_ms, latency_objective_ms, retries, retry_delay_ms, keyword, period_ms, grace_ms, method, headers_json, body, expected_status_json, json_assert_json, dns_name, record_type, expected_json, resolver, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, type = excluded.type,
      host = excluded.host, port = excluded.port, warn_days = excluded.warn_days,
      interval_ms = excluded.interval_ms, timeout_ms = excluded.timeout_ms,
      latency_objective_ms = excluded.latency_objective_ms,
      retries = excluded.retries, retry_delay_ms = excluded.retry_delay_ms,
      keyword = excluded.keyword, period_ms = excluded.period_ms, grace_ms = excluded.grace_ms,
      method = excluded.method, headers_json = excluded.headers_json, body = excluded.body,
      expected_status_json = excluded.expected_status_json, json_assert_json = excluded.json_assert_json,
      dns_name = excluded.dns_name, record_type = excluded.record_type,
      expected_json = excluded.expected_json, resolver = excluded.resolver, domain = excluded.domain,
      active = 1`);
  const clearOptions = db.prepare(
    `UPDATE checks SET keyword = NULL, method = NULL, headers_json = NULL, body = NULL,
       expected_status_json = NULL, json_assert_json = NULL
     WHERE keyword IS NOT NULL OR method IS NOT NULL OR headers_json IS NOT NULL OR body IS NOT NULL
       OR expected_status_json IS NOT NULL OR json_assert_json IS NOT NULL`,
  );
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (check_id, location, timestamp) DO NOTHING`,
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
  const newestAny = db.prepare("SELECT MAX(timestamp) AS t FROM results WHERE check_id = ?");
  // Loose index scan over (check_id, location, timestamp): one seek per location, not a scan of the history.
  const locationsOf = db.prepare(
    `WITH RECURSIVE locs(l) AS (
       SELECT MIN(location) FROM results WHERE check_id = ?
       UNION ALL
       SELECT (SELECT MIN(location) FROM results WHERE check_id = ? AND location > locs.l)
       FROM locs WHERE l IS NOT NULL)
     SELECT l FROM locs WHERE l IS NOT NULL`,
  );
  const latestOfLocation = db.prepare(
    `SELECT * FROM results WHERE check_id = ? AND location = ?
     ORDER BY timestamp DESC, id DESC LIMIT 1`,
  );
  const latestPerLocation = (checkId: string): ResultRow[] =>
    (locationsOf.all(checkId, checkId) as unknown as { l: string }[]).flatMap(({ l }) => {
      const row = latestOfLocation.get(checkId, l) as ResultRow | null;
      return row ? [row] : [];
    });
  const dailyUptime = db.prepare(
    `SELECT CAST(timestamp / ${DAY_MS} AS INTEGER) AS day,
            SUM(status != 'down') AS good, COUNT(*) AS total
     FROM results WHERE check_id = ? AND timestamp >= ? AND timestamp <= ?
     GROUP BY day`,
  );
  const listResultsPage = db.prepare(
    "SELECT * FROM results WHERE check_id = ? AND timestamp < ? ORDER BY timestamp DESC, id DESC LIMIT ?",
  );
  const tiedRows = db.prepare(
    "SELECT * FROM results WHERE check_id = ? AND timestamp = ? AND id < ? ORDER BY id DESC",
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
  const largestInterval = db.prepare(
    "SELECT MAX(interval_ms) AS m FROM checks WHERE active = 1 AND type != 'heartbeat'",
  );
  const newestPerLocation = db.prepare(
    "SELECT location, MAX(timestamp) AS t FROM results WHERE location != ? GROUP BY location",
  );
  for (const row of newestPerLocation.all(HEARTBEAT_LOCATION) as {
    location: string;
    t: number;
  }[]) {
    tracker.set(row.location, { lastResultAt: row.t, lastSeenAt: row.t });
  }
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

  /** certDaysLeft is emitted for TLS and domain checks (null when unread) and for any stored value. */
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

  function toCheck(r: CheckRow, isFull = false): CheckWithState {
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
    const c = baseCheck(r, state);
    if (r.timeout_ms !== null) c.timeoutMs = r.timeout_ms;
    if (c.type === undefined || c.type === "http") {
      if (r.latency_objective_ms !== null) c.latencyObjectiveMs = r.latency_objective_ms;
      if (r.keyword !== null) c.keyword = r.keyword;
      addRequestOptions(c, r, isFull);
    }
    return c;
  }

  function baseCheck(
    r: CheckRow,
    state: CheckStateFields,
  ): Exclude<CheckWithState, { type: "heartbeat" }> {
    const base = { id: r.id, name: r.name };
    const retries = { retries: r.retries ?? 0, retryDelayMs: r.retry_delay_ms ?? 1000 };
    switch (r.type ?? "http") {
      case "tls":
        return {
          ...base,
          type: "tls",
          host: r.host ?? "",
          port: r.port ?? 0,
          warnDays: r.warn_days ?? 0,
          intervalMs: r.interval_ms,
          ...state,
        };
      case "tcp":
        return {
          ...base,
          type: "tcp",
          host: r.host ?? "",
          port: r.port ?? 0,
          intervalMs: r.interval_ms,
          ...retries,
          ...state,
        };
      case "dns": {
        const expected = readColumn(DNS_EXPECTED_COLUMN, r.expected_json);
        const recordType = dnsRecordTypeSchema.safeParse(r.record_type);
        return {
          ...base,
          type: "dns",
          dnsName: r.dns_name ?? "",
          recordType: recordType.success ? recordType.data : "A",
          ...(expected === undefined ? {} : { expected }),
          ...(r.resolver === null ? {} : { resolver: r.resolver }),
          intervalMs: r.interval_ms,
          ...retries,
          ...state,
        };
      }
      case "domain":
        return {
          ...base,
          type: "domain",
          domain: r.domain ?? "",
          warnDays: r.warn_days ?? 0,
          intervalMs: r.interval_ms,
          ...retries,
          ...state,
        };
      case "http":
      default:
        return {
          ...base,
          url: r.url ?? "",
          intervalMs: r.interval_ms,
          ...retries,
          ...state,
        };
    }
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
    // A down inside a maintenance window never counts, also when it arrived after the window ended.
    const counted = rows.filter((r) => !(r.status === "down" && inWindow(r.check_id, r.timestamp)));
    const latest = new Map<string, ResultRow>();
    for (const r of counted) if (!latest.has(r.location)) latest.set(r.location, r);
    return {
      combined: quorumStatus([...latest.values()].map((r) => r.status)),
      downReason: counted.find((r) => r.status === "down")?.reason ?? result.reason,
    };
  }

  function transaction(fn: () => void): void {
    db.run("BEGIN");
    try {
      fn();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  }

  function computeChecks(): CheckWithState[] {
    const t = now();
    return (
      db
        .prepare("SELECT * FROM checks WHERE active = 1 ORDER BY rowid")
        .all() as unknown as CheckRow[]
    ).map((r) => {
      const c = toCheck(r);
      const tls = hasDaysLeft(c.type);
      const intervalMs = c.type === "heartbeat" ? c.period : c.intervalMs;
      const latest = latestPerLocation(c.id).map((l) => toResult(l, tls));
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
  }

  function computeUptime(): CheckUptime[] {
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
  }

  return {
    upsertChecks(checks) {
      let resolved = 0;
      invalidate();
      transaction(() => {
        // Clear first, then upsert: checks removed from the file lose their keyword and request options without a long NOT IN list.
        clearOptions.run();
        deactivateAll.run();
        for (const c of checks) upsert.run(...columnsOf(c));
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
      let isNew = true;
      invalidate();
      transaction(() => {
        const row = getActiveCheck.get(result.checkId) as CheckRow | undefined;
        if (!row) throw new UnknownCheckError(result.checkId);
        // Read before the insert, so the new row is not compared with itself.
        const newestOfCheck = (newestAny.get(result.checkId) as { t: number | null } | undefined)
          ?.t;
        const newest = (
          newestStored.get(result.checkId, result.location) as { t: number | null } | undefined
        )?.t;
        const isHeartbeat = row.type === "heartbeat";
        // Heartbeat timestamps come from the api clock, so lateness does not apply.
        const isLate =
          !isHeartbeat && newest !== null && newest !== undefined && result.timestamp < newest;
        // A repeat of a stored sample (a probe re-sending after a lost answer) changes nothing.
        if (!storeSample(result, isLate, isHeartbeat)) {
          isNew = false;
          return;
        }
        trackLocation(result.location, result.timestamp);
        // A late result is history only: it must not rewrite live state or incidents.
        if (isLate) return;
        // Older than the newest result of any location: history and quorum input only.
        if (
          !isHeartbeat &&
          newestOfCheck !== null &&
          newestOfCheck !== undefined &&
          result.timestamp < newestOfCheck
        ) {
          return;
        }
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
            incidentOpen: hasOpen.get(result.checkId) != null,
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
      return isNew;
    },

    listLocations() {
      const threshold = silentThreshold();
      const t = now();
      return [...tracker.entries()]
        .map(([name, seen]) => ({
          name,
          lastResultAt: seen.lastResultAt,
          state: t - seen.lastSeenAt > threshold ? ("silent" as const) : ("reporting" as const),
        }))
        .sort((a, b) => compareNames(a.name, b.name));
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
      return cached("checks", () => computeChecks());
    },

    listProbeChecks() {
      return (
        db
          .prepare("SELECT * FROM checks WHERE active = 1 ORDER BY rowid")
          .all() as unknown as CheckRow[]
      ).map((r) => {
        const check: Check = toCheck(r, true);
        for (const key of STATE_KEYS) Reflect.deleteProperty(check, key);
        return check;
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
      return cached("uptime", computeUptime);
    },

    deleteExpiredResults(cutoff, limit) {
      const deleted = Number(deleteExpired.run(cutoff, limit).changes);
      if (deleted > 0) invalidate();
      return deleted;
    },

    hasCheck(id) {
      return getCheck.get(id) != null;
    },

    findActiveCheck(id) {
      const row = getActiveCheck.get(id) as CheckRow | null;
      return row ? toCheck(row) : undefined;
    },

    listResults(checkId, limit, before) {
      const upper = before ?? Number.MAX_SAFE_INTEGER;
      const rows = listResultsPage.all(checkId, upper, limit) as unknown as ResultRow[];
      const last = rows.at(-1);
      if (rows.length === limit && last !== undefined) {
        // Equal timestamps (several locations) must not be split across pages: the next page starts below them.
        rows.push(...(tiedRows.all(checkId, last.timestamp, last.id) as unknown as ResultRow[]));
      }
      const tls = hasDaysLeft((getCheck.get(checkId) as CheckRow | undefined)?.type);
      return rows.map((r) => toResult(r, tls));
    },

    listIncidents(status, { limit, since } = {}) {
      const conditions: string[] = [];
      const params: number[] = [];
      if (status === "open") conditions.push("resolved_at IS NULL");
      else if (status === "resolved") conditions.push("resolved_at IS NOT NULL");
      if (since !== undefined) {
        conditions.push("(opened_at >= ? OR resolved_at >= ? OR resolved_at IS NULL)");
        params.push(since, since);
      }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      const rows = db
        .prepare(
          `SELECT * FROM incidents ${where}
           ORDER BY (resolved_at IS NOT NULL), opened_at DESC, id DESC${limit === undefined ? "" : " LIMIT ?"}`,
        )
        .all(...params, ...(limit === undefined ? [] : [limit])) as unknown as IncidentRow[];
      return rows.map((r) => ({
        id: r.id,
        checkId: r.check_id,
        openedAt: r.opened_at,
        resolvedAt: r.resolved_at,
        reason: r.reason,
      }));
    },

    isDbReady() {
      try {
        db.prepare("SELECT 1").get();
        return true;
      } catch {
        // Any failure means not ready; the cause stays out of the probe answer.
        return false;
      }
    },
  };
}
