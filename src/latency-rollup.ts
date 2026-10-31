import type { Service } from "./service.ts";

export const LATENCY_ROLLUP_INTERVAL_MS = 3_600_000;
/** Pause between listen and the first run, so the backfill stays out of the startup work. */
export const LATENCY_ROLLUP_START_DELAY_MS = 5_000;

export interface LatencyRollupDeps {
  service: Pick<Service, "listLatencyCheckIds" | "missingLatencyDays" | "fillLatencyRollupDay">;
  sleep: (ms: number) => Promise<void>;
  /** The callback returns the run, so a fake clock can await it. */
  setTimeout: (fn: () => Promise<void>, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (message: string, level: "info" | "warn") => void;
  /** Clock for the run duration in the log lines. */
  now: () => number;
  /** Time between runs; defaults to LATENCY_ROLLUP_INTERVAL_MS. Tests shorten it. */
  intervalMs?: number;
  /** Time before the first run; defaults to LATENCY_ROLLUP_START_DELAY_MS. */
  startDelayMs?: number;
}

export interface LatencyRollupRunner {
  /** Stop scheduling runs and resolve when the run in progress (if any) has ended. */
  stop(): Promise<void>;
  /** The run in progress, or the last one. */
  readonly done: Promise<void>;
}

export interface RollupFill {
  /** The HTTP checks the run looked at. */
  checks: number;
  /** The days stored. */
  written: number;
}

/**
 * Fill the missing closed-day rollups of every HTTP check, one (check, day) per batch with a
 * yield after each, so a request never waits for more than one day of work.
 */
export async function fillAllRollups(
  deps: Pick<LatencyRollupDeps, "service" | "sleep">,
  isStopped: () => boolean = () => false,
): Promise<RollupFill> {
  const ids = deps.service.listLatencyCheckIds();
  let written = 0;
  for (const id of ids) {
    for (const day of deps.service.missingLatencyDays(id)) {
      if (isStopped()) return { checks: ids.length, written };
      if (deps.service.fillLatencyRollupDay(id, day)) written++;
      await deps.sleep(0);
    }
  }
  return { checks: ids.length, written };
}

/**
 * Run the backfill after the start delay and then hourly. The next run is scheduled when one
 * ends. The first run always logs a start and a done line; an hourly run logs only when it stored days.
 */
export function startLatencyRollup(deps: LatencyRollupDeps): LatencyRollupRunner {
  let isStopped = false;
  let isFirst = true;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  const runOnce = async (isBackfill: boolean): Promise<void> => {
    const started = deps.now();
    if (isBackfill) {
      deps.log(
        `latency rollup: backfill started (${deps.service.listLatencyCheckIds().length} checks)`,
        "info",
      );
    }
    const { written } = await fillAllRollups(deps, () => isStopped);
    const ms = Math.round(deps.now() - started);
    if (isBackfill)
      deps.log(`latency rollup: backfill done, stored ${written} days in ${ms} ms`, "info");
    else if (written > 0) deps.log(`latency rollup: stored ${written} days in ${ms} ms`, "info");
  };
  const run = (): Promise<void> => {
    if (isStopped) return Promise.resolve();
    const isBackfill = isFirst;
    isFirst = false;
    current = (async (): Promise<void> => {
      try {
        await runOnce(isBackfill);
      } catch (err) {
        deps.log(
          `latency rollup failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "warn",
        );
      }
      if (!isStopped) handle = deps.setTimeout(run, deps.intervalMs ?? LATENCY_ROLLUP_INTERVAL_MS);
    })();
    return current;
  };
  handle = deps.setTimeout(run, deps.startDelayMs ?? LATENCY_ROLLUP_START_DELAY_MS);
  return {
    get done() {
      return current;
    },
    stop() {
      isStopped = true;
      if (handle !== undefined) deps.clearTimeout(handle);
      return current;
    },
  };
}
