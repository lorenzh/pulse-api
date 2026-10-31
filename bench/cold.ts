// The cold-read phase: first reads after an api restart on a 10x seed. See bench/README.md.
// The pure parts (seed row layout, settle rule, limit check) are covered by selftest/check-cold.ts.
import { Database } from "bun:sqlite";
import { parseProcStatCpuSeconds, readContainerProcess, runChecked } from "./measure.ts";

/** Results per minute per check of the cold-read seed. */
export const COLD_DENSITY = 10;
/** The CPU time of a settled api grows by less than this over `SETTLE_WINDOW_MS`. */
export const SETTLE_DELTA_MS = 20;
export const SETTLE_WINDOW_MS = 2000;
export const SETTLE_MAX_MS = 300_000;
/** Client timeout of one cold request. */
export const COLD_REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 600_000;
const POLL_MS = 50;
const MINUTE_MS = 60_000;

export interface SeedRow {
  /** The row's timestamp is `now - offsetMs`. */
  offsetMs: number;
  status: "up" | "down";
  latencyMs: number;
}

/**
 * The rows of minute `k` (0 is the newest) of one check at density `n`. Row `j = 0` is the 1x row,
 * unchanged. Every extra row whose index `k * n + j` is divisible by 97 is `down`.
 */
export function seedRowsOfMinute(k: number, n: number): SeedRow[] {
  const rows: SeedRow[] = [
    { offsetMs: k * MINUTE_MS, status: "up", latencyMs: 5 + ((k * 7) % 300) },
  ];
  for (let j = 1; j < n; j++) {
    const index = k * n + j;
    rows.push({
      offsetMs: k * MINUTE_MS + Math.floor((j * MINUTE_MS) / n),
      status: index % 97 === 0 ? "down" : "up",
      latencyMs: 5 + ((index * 7) % 300),
    });
  }
  return rows;
}

/** The probe locations of the extra rows of today; the seed itself writes only `default`. */
export const EXTRA_TODAY_LOCATIONS = ["sim1", "sim2"] as const;

export interface ExtraTodayRow {
  location: string;
  timestamp: number;
  status: "up" | "down";
  latencyMs: number;
}

/**
 * The extra rows of one check that lift today's rows of a seed from `existing` to at least
 * `target`, spread over `checks` checks and the two extra locations. Their timestamps lie evenly
 * between the UTC midnight of `now` (excluded) and `now`; every 97th row is `down`.
 */
export function extraTodayRows(
  existing: number,
  target: number,
  checks: number,
  now: number,
): ExtraTodayRow[] {
  const series = checks * EXTRA_TODAY_LOCATIONS.length;
  const perSeries = Math.ceil(Math.max(0, target - existing) / series);
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  const span = now - midnight;
  if (perSeries > span) throw new Error(`${perSeries} rows per series do not fit in ${span} ms`);
  return EXTRA_TODAY_LOCATIONS.flatMap((location) =>
    Array.from(
      { length: perSeries },
      (_, m): ExtraTodayRow => ({
        location,
        timestamp: midnight + Math.floor(((m + 1) * span) / perSeries),
        status: m % 97 === 96 ? "down" : "up",
        latencyMs: 5 + ((m * 7) % 300),
      }),
    ),
  );
}

/** The last line of `bench/seed.ts`. */
export function seededLine(rows: number, intervalMs: number, density: number, now: number): string {
  return `seeded ${rows} results (check interval ${intervalMs} ms, density ${density}, now ${now})`;
}

/** True when the api's CPU time grew by less than `SETTLE_DELTA_MS` over one settle window. */
export function isSettled(beforeMs: number, afterMs: number): boolean {
  return afterMs - beforeMs < SETTLE_DELTA_MS;
}

export interface ColdMetrics {
  cold_get_checks_ms: number;
  cold_get_uptime_ms: number;
  cold_read_cpu_ms: number;
  cold_concurrent_ms: number;
}

/** The wall metrics at or above `limitMs`, each checked on its own. */
export function overLimit(metrics: ColdMetrics, limitMs: number): (keyof ColdMetrics)[] {
  const keys = ["cold_get_checks_ms", "cold_get_uptime_ms", "cold_concurrent_ms"] as const;
  return keys.filter((key) => metrics[key] >= limitMs);
}

/** One api process the procedure can start, restart and read. */
export interface ColdTarget {
  /** Start the api; resolves with its base URL at the first `200` of `/readyz`. */
  start(): Promise<string>;
  /** Stop it with SIGTERM and start it again; resolves like `start`. */
  restart(): Promise<string>;
  /** CPU time (utime + stime) of the api process in ms. */
  cpuMs(): Promise<number>;
}

export interface StartSample {
  readyWallMs: number;
  readyCpuMs: number;
}

export interface ColdResult extends ColdMetrics {
  warm_get_checks_ms: number;
  warm_get_uptime_ms: number;
  warm_settle_ms: number;
  /** ISO time of the first cold request and of the concurrent pair. */
  utc_start: string;
  utc_concurrent: string;
}

/** GET a route with a 30 s timeout; the wall time to the end of the body, in ms. */
export async function timedGet(base: string, path: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(COLD_REQUEST_TIMEOUT_MS),
  });
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`);
  return Math.round(performance.now() - started);
}

async function isReady(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/readyz`, { headers: { connection: "close" } });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    // Not listening yet: the poll tries again until the timeout.
    return false;
  }
}

/** Poll `/readyz` every 50 ms until it answers `200`. */
export async function waitReady(base: () => Promise<string>): Promise<string> {
  const started = performance.now();
  while (performance.now() - started < READY_TIMEOUT_MS) {
    try {
      const url = await base();
      if (await isReady(url)) return url;
    } catch {
      // The port is not published yet: try again.
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`api was not ready within ${READY_TIMEOUT_MS / 1000} s`);
}

/** Wait until the CPU time grows by less than 20 ms over 2 s, at most 300 s. Returns the wait. */
export async function settle(target: Pick<ColdTarget, "cpuMs">): Promise<number> {
  const started = performance.now();
  let before = await target.cpuMs();
  while (performance.now() - started < SETTLE_MAX_MS) {
    await Bun.sleep(SETTLE_WINDOW_MS);
    const after = await target.cpuMs();
    if (isSettled(before, after)) return Math.round(performance.now() - started);
    before = after;
  }
  throw new Error(`api CPU did not settle within ${SETTLE_MAX_MS / 1000} s`);
}

/**
 * Steps 1-3 of the cold-read phase: a warm start with one read of each route and a CPU settle,
 * then a restart with the two reads in sequence, then a restart with both at once.
 */
export async function runColdReads(
  target: ColdTarget,
  log: (line: string) => void,
): Promise<ColdResult> {
  let base = await target.start();
  const warmChecks = await timedGet(base, "/checks");
  const warmUptime = await timedGet(base, "/uptime");
  const warmSettle = await settle(target);
  log(`cold: warm start settled after ${warmSettle} ms`);

  base = await target.restart();
  const cpuBefore = await target.cpuMs();
  const utcStart = new Date().toISOString();
  const checks = await timedGet(base, "/checks");
  const uptime = await timedGet(base, "/uptime");
  const cpuAfter = await target.cpuMs();
  log(`cold: sequential reads at ${utcStart}: /checks ${checks} ms, /uptime ${uptime} ms`);

  base = await target.restart();
  const utcConcurrent = new Date().toISOString();
  const started = performance.now();
  await Promise.all([timedGet(base, "/checks"), timedGet(base, "/uptime")]);
  const concurrent = Math.round(performance.now() - started);
  log(`cold: concurrent reads at ${utcConcurrent}: ${concurrent} ms`);
  return {
    cold_get_checks_ms: checks,
    cold_get_uptime_ms: uptime,
    cold_read_cpu_ms: Math.round(cpuAfter - cpuBefore),
    cold_concurrent_ms: concurrent,
    warm_get_checks_ms: warmChecks,
    warm_get_uptime_ms: warmUptime,
    warm_settle_ms: warmSettle,
    utc_start: utcStart,
    utc_concurrent: utcConcurrent,
  };
}

/** The rows of a seed at or after the UTC midnight of `now`, read without writing. */
export function countTodayRows(dbPath: string, now: number): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const midnight = Math.floor(now / 86_400_000) * 86_400_000;
    const row = db.query("SELECT COUNT(*) AS n FROM results WHERE timestamp >= ?").get(midnight);
    return (row as { n: number } | null)?.n ?? 0;
  } finally {
    db.close();
  }
}

/**
 * Insert the extra rows of today (see `extraTodayRows`) for every check of `checkIds` into a
 * seeded file, until it holds at least `target` rows since the UTC midnight of `now`. Returns the
 * number of rows added.
 */
export function addTodayRows(
  dbPath: string,
  checkIds: readonly string[],
  target: number,
  now: number,
): number {
  const rows = extraTodayRows(countTodayRows(dbPath, now), target, checkIds.length, now);
  if (rows.length === 0) return 0;
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(
      "INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, attempts) VALUES (?, ?, ?, ?, ?, NULL, ?, 1)",
    );
    db.transaction(() => {
      for (const id of checkIds) {
        for (const row of rows) {
          const code = row.status === "up" ? 200 : 503;
          insert.run(id, row.timestamp, row.status, code, row.latencyMs, row.location);
        }
      }
    })();
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return rows.length * checkIds.length;
  } finally {
    db.close();
  }
}

/** CPU time in ms of a local process, from `/proc/<pid>/stat`. */
export async function processCpuMs(pid: number): Promise<number> {
  return parseProcStatCpuSeconds(await Bun.file(`/proc/${pid}/stat`).text()) * 1000;
}

export interface ComposeApi {
  /** `docker compose -f <file> -p <project>`. */
  compose: string[];
  env: Record<string, string>;
  container: string;
}

async function composeBase(api: ComposeApi): Promise<string> {
  const { stdout } = await runChecked("docker", [...api.compose, "port", "api", "3000"], {
    env: api.env,
  });
  const port = Number(stdout.trim().split(":").pop());
  if (!Number.isInteger(port) || port === 0) throw new Error("no published port for api");
  return `http://127.0.0.1:${port}`;
}

/** The api service of `compose.bench.yaml`; the run directory holds a fresh copy of the 10x seed. */
export function composeTarget(api: ComposeApi): ColdTarget {
  return {
    start: async () => {
      await runChecked("docker", [...api.compose, "up", "-d", "--no-build", "api"], {
        env: api.env,
      });
      return waitReady(() => composeBase(api));
    },
    restart: async () => {
      // `restart` sends SIGTERM; the published host port may change.
      await runChecked("docker", [...api.compose, "restart", "api"], { env: api.env });
      return waitReady(() => composeBase(api));
    },
    cpuMs: async () => (await readContainerProcess(api.container)).cpuSeconds * 1000,
  };
}
