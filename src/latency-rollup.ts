import type { Service } from "./service.ts";

export const LATENCY_ROLLUP_INTERVAL_MS = 3_600_000;

export interface LatencyRollupDeps {
  service: Pick<Service, "listLatencyCheckIds" | "fillLatencyRollups">;
  sleep: (ms: number) => Promise<void>;
  /** The callback returns the run, so a fake clock can await it. */
  setTimeout: (fn: () => Promise<void>, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (message: string) => void;
  /** Time between runs; defaults to LATENCY_ROLLUP_INTERVAL_MS. Tests shorten it. */
  intervalMs?: number;
}

export interface LatencyRollupRunner {
  /** Stop scheduling runs and resolve when the run in progress (if any) has ended. */
  stop(): Promise<void>;
  /** The run in progress, or the last one. */
  readonly done: Promise<void>;
}

/**
 * Fill the missing closed-day rollups of every HTTP check, one check at a time with a yield in
 * between, so the work never sits inside a request. Returns the days written.
 */
export async function fillAllRollups(
  deps: Pick<LatencyRollupDeps, "service" | "sleep">,
  isStopped: () => boolean = () => false,
): Promise<number> {
  let written = 0;
  for (const id of deps.service.listLatencyCheckIds()) {
    if (isStopped()) break;
    written += deps.service.fillLatencyRollups(id);
    await deps.sleep(0);
  }
  return written;
}

/** Run the backfill at once and then hourly. The next run is scheduled when one ends. */
export function startLatencyRollup(deps: LatencyRollupDeps): LatencyRollupRunner {
  let isStopped = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    if (isStopped) return Promise.resolve();
    current = (async (): Promise<void> => {
      try {
        const written = await fillAllRollups(deps, () => isStopped);
        if (written > 0) deps.log(`latency rollup: stored ${written} days`);
      } catch (err) {
        deps.log(`latency rollup failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
      if (!isStopped) handle = deps.setTimeout(run, deps.intervalMs ?? LATENCY_ROLLUP_INTERVAL_MS);
    })();
    return current;
  };
  // Started on the next turn: the first run must not delay the listener.
  handle = deps.setTimeout(run, 0);
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
