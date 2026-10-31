import type { Service } from "./service.ts";

export const UPTIME_ROLLUP_INTERVAL_MS = 3_600_000;
/** Pause between listen and the first run, so the backfill stays out of the startup work. */
export const UPTIME_ROLLUP_START_DELAY_MS = 5_000;

export interface UptimeRollupDeps {
  service: Pick<Service, "listUptimeCheckIds" | "missingUptimeDays" | "fillUptimeDay">;
  sleep: (ms: number) => Promise<void>;
  /** The callback returns the run, so a fake clock can await it. */
  setTimeout: (fn: () => Promise<void>, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (message: string, level: "info" | "warn") => void;
  /** Clock for the run duration in the log lines. */
  now: () => number;
  /** Time between runs; defaults to UPTIME_ROLLUP_INTERVAL_MS. Tests shorten it. */
  intervalMs?: number;
  /** Time before the first run; defaults to UPTIME_ROLLUP_START_DELAY_MS. */
  startDelayMs?: number;
}

export interface UptimeRollupRunner {
  /** Stop scheduling runs and resolve when the run in progress (if any) has ended. */
  stop(): Promise<void>;
  /** The run in progress, or the last one. */
  readonly done: Promise<void>;
}

export interface UptimeFill {
  /** The active checks the run looked at. */
  checks: number;
  /** The days stored. */
  written: number;
}

/**
 * Fill the missing closed-day uptime tallies of every active check, one (check, day) per batch
 * with a yield after each, so a request never waits for more than one day of work.
 */
export async function fillAllUptimeDays(
  deps: Pick<UptimeRollupDeps, "service" | "sleep">,
  isStopped: () => boolean = () => false,
): Promise<UptimeFill> {
  const ids = deps.service.listUptimeCheckIds();
  let written = 0;
  for (const id of ids) {
    for (const day of deps.service.missingUptimeDays(id)) {
      if (isStopped()) return { checks: ids.length, written };
      if (deps.service.fillUptimeDay(id, day)) written++;
      await deps.sleep(0);
    }
  }
  return { checks: ids.length, written };
}

/**
 * Run the uptime backfill after the start delay and then hourly. The next run is scheduled when
 * one ends. The first run always logs a start and a done line; an hourly run logs only when it
 * stored days.
 */
export function startUptimeRollup(deps: UptimeRollupDeps): UptimeRollupRunner {
  let isStopped = false;
  let isFirst = true;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  const runOnce = async (isBackfill: boolean): Promise<void> => {
    const started = deps.now();
    if (isBackfill) {
      deps.log(
        `uptime rollup: backfill started (${deps.service.listUptimeCheckIds().length} checks)`,
        "info",
      );
    }
    const { written } = await fillAllUptimeDays(deps, () => isStopped);
    const ms = Math.round(deps.now() - started);
    if (isBackfill)
      deps.log(`uptime rollup: backfill done, stored ${written} days in ${ms} ms`, "info");
    else if (written > 0) deps.log(`uptime rollup: stored ${written} days in ${ms} ms`, "info");
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
          `uptime rollup failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "warn",
        );
      }
      if (!isStopped) handle = deps.setTimeout(run, deps.intervalMs ?? UPTIME_ROLLUP_INTERVAL_MS);
    })();
    return current;
  };
  handle = deps.setTimeout(run, deps.startDelayMs ?? UPTIME_ROLLUP_START_DELAY_MS);
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
