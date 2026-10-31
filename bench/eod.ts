// The end-of-day phase: reads right after an ingest with a full UTC day of results. See bench/README.md.
// The pure parts (p95, midnight wait, limit check, components) are covered by selftest/check-eod.ts.
import { type ColdTarget, settle, timedGet } from "./cold.ts";
import { benchTokens, checkIds, type OptionalRoute } from "./load.ts";

/** Rows of today in the phase's seed: 20 checks x 3 locations x one result per 10 s x 86 400 s. */
export const EOD_TODAY_ROWS = 518_400;
/** Measured cycles; each sends one ingest and then one ingest before each route's GET. */
export const EOD_CYCLES = 20;
/** Before this time of the UTC day, today's rows do not fit between midnight and now. */
export const EOD_EARLIEST_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The measured routes with their metric key and, for routes newer than the oldest A, the optional route. */
export const EOD_ROUTES = [
  { metric: "eod_get_checks_ms", path: "/checks" },
  { metric: "eod_get_uptime_ms", path: "/uptime" },
  { metric: "eod_get_latency_ms", path: "/latency", optional: "/latency" },
  {
    metric: "eod_get_check_latency_ms",
    path: `/checks/${checkIds()[0] ?? ""}/latency`,
    optional: "/checks/:id/latency",
  },
  { metric: "eod_get_components_ms", path: "/components", optional: "/components" },
  {
    metric: "eod_get_components_uptime_ms",
    path: "/components/uptime",
    optional: "/components/uptime",
  },
] as const satisfies readonly { metric: string; path: string; optional?: OptionalRoute }[];

export type EodRouteMetric = (typeof EOD_ROUTES)[number]["metric"];
export type EodMetricKey = EodRouteMetric | "eod_read_cpu_ms";
export const EOD_METRICS: readonly EodMetricKey[] = [
  ...EOD_ROUTES.map((r) => r.metric),
  "eod_read_cpu_ms",
];

/** Nearest-rank p95: the value at 1-based index `ceil(0.95 * n)`; of 20 samples the 19th smallest. */
export function nearestRankP95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.NaN;
}

function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? Number.NaN;
  return ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}

/** True before 00:10:00 UTC: the phase waits until then. */
export function mustWaitForMidnight(utcMs: number): boolean {
  return utcMs - Math.floor(utcMs / DAY_MS) * DAY_MS < EOD_EARLIEST_MS;
}

/** The two limited metrics of `eod-read.ts` that are at or above their limit. */
export function overEodLimits(
  metrics: Pick<EodResult, "eod_get_checks_ms" | "eod_get_latency_ms">,
  checksLimitMs: number,
  latencyLimitMs: number,
): ("eod_get_checks_ms" | "eod_get_latency_ms")[] {
  const failed: ("eod_get_checks_ms" | "eod_get_latency_ms")[] = [];
  if (metrics.eod_get_checks_ms !== null && metrics.eod_get_checks_ms >= checksLimitMs) {
    failed.push("eod_get_checks_ms");
  }
  if (metrics.eod_get_latency_ms !== null && metrics.eod_get_latency_ms >= latencyLimitMs) {
    failed.push("eod_get_latency_ms");
  }
  return failed;
}

/** The api process of the phase. */
export interface EodTarget extends Pick<ColdTarget, "start" | "cpuMs"> {
  /** `VmRSS` of the api process in MiB. */
  rssMiB(): Promise<number>;
}

/** A route metric is null when side A lacks the route. */
export type EodResult = Record<EodRouteMetric, number | null> & {
  eod_read_cpu_ms: number;
  /** The median of each measured route, in ms. */
  medians: Partial<Record<EodRouteMetric, number>>;
  vm_rss_mib: number;
  utc_start: string;
};

const POST_TIMEOUT_MS = 30_000;

/** POST /results with the token of `sim1`; every timestamp is above the one before. */
function poster(base: string): (checkId: string, latencyMs: number) => Promise<void> {
  const probe = benchTokens().simulated[1];
  if (probe === undefined) throw new Error("no sim1 token");
  let last = 0;
  return async (checkId, latencyMs) => {
    const timestamp = Math.max(Date.now(), last + 1);
    last = timestamp;
    const response = await fetch(`${base}/results`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${probe.token}`,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        checkId,
        timestamp,
        status: "up",
        statusCode: 200,
        latencyMs,
        reason: null,
        attempts: 1,
      }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    if (response.status !== 204) throw new Error(`POST /results answered ${response.status}`);
  };
}

/**
 * Steps 1-3 of the end-of-day phase on a started seed: warm reads and a CPU settle, then
 * `EOD_CYCLES` cycles in which every measured GET follows one accepted ingest.
 */
export async function runEodReads(
  target: EodTarget,
  log: (line: string) => void,
  missingRoutes: readonly OptionalRoute[] = [],
  cycles = EOD_CYCLES,
): Promise<EodResult> {
  const routes = EOD_ROUTES.filter(
    (r) => !("optional" in r) || !missingRoutes.includes(r.optional),
  );
  const base = await target.start();
  for (const route of routes) await timedGet(base, route.path);
  const settled = await settle(target);
  log(`eod: warm reads settled after ${settled} ms`);

  const ids = checkIds();
  const post = poster(base);
  const samples = new Map<EodRouteMetric, number[]>(routes.map((r) => [r.metric, []]));
  const utcStart = new Date().toISOString();
  const cpuBefore = await target.cpuMs();
  for (let i = 0; i < cycles; i++) {
    await post(ids[i % ids.length] ?? "", 5 + i);
    for (const [j, route] of routes.entries()) {
      await post(ids[(i + 1 + j) % ids.length] ?? "", 5 + i);
      samples.get(route.metric)?.push(await timedGet(base, route.path));
    }
  }
  const cpuAfter = await target.cpuMs();
  const rss = await target.rssMiB();
  const result: EodResult = {
    eod_get_checks_ms: null,
    eod_get_uptime_ms: null,
    eod_get_latency_ms: null,
    eod_get_check_latency_ms: null,
    eod_get_components_ms: null,
    eod_get_components_uptime_ms: null,
    eod_read_cpu_ms: Math.round(cpuAfter - cpuBefore),
    medians: {},
    vm_rss_mib: Math.round(rss * 10) / 10,
    utc_start: utcStart,
  };
  for (const [metric, values] of samples) {
    result[metric] = nearestRankP95(values);
    result.medians[metric] = medianOf(values);
  }
  log(
    `eod: ${cycles} cycles from ${utcStart}: cpu ${result.eod_read_cpu_ms} ms, VmRSS ${result.vm_rss_mib} MiB`,
  );
  return result;
}

export interface EodPhase {
  /** Copy the seed and add today's rows; resolves with the rows of today. */
  seed(now: number): Promise<number>;
  /** Start the api on the seed, run `runEodReads` and stop it. */
  measure(): Promise<EodResult>;
}

/**
 * Wait until 00:10 UTC when needed, seed, measure. When the UTC day changes between seeding and
 * the last cycle, seed and measure once more; a second change is a harness error.
 */
export async function runEodPhase(
  phase: EodPhase,
  log: (line: string) => void,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
): Promise<EodResult & { today_rows: number }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t = now();
    if (mustWaitForMidnight(t)) {
      log("eod: waiting until 00:10 UTC so today's rows fit");
      await sleep(Math.floor(t / DAY_MS) * DAY_MS + EOD_EARLIEST_MS - t);
    }
    const seededAt = now();
    const todayRows = await phase.seed(seededAt);
    log(`eod: ${todayRows} rows of today at ${new Date(seededAt).toISOString()}`);
    const result = await phase.measure();
    if (Math.floor(now() / DAY_MS) === Math.floor(seededAt / DAY_MS)) {
      return { ...result, today_rows: todayRows };
    }
    log("eod: the UTC day changed during the phase");
  }
  throw new Error("eod: the UTC day changed twice during the phase");
}
