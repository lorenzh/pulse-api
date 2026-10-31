import { type Env, readMs } from "@lorenzh/pulse-kit";
import { DAY_MS, type Service, UPTIME_DAYS } from "./service.ts";

export const RETENTION_BATCH_SIZE = 1000;
export const RETENTION_INTERVAL_MS = 3_600_000;
const DEFAULT_RETENTION_DAYS = UPTIME_DAYS;

/** Read `PULSE_RETENTION_DAYS`: unset or empty gives the default, else an integer >= UPTIME_DAYS. */
export function readRetentionDays(env: Env): number {
  return readMs(env, "PULSE_RETENTION_DAYS", {
    fallback: DEFAULT_RETENTION_DAYS,
    min: UPTIME_DAYS,
  });
}

/** First instant kept: the start of the UTC day `retentionDays - 1` days before today. */
export function retentionCutoff(now: number, retentionDays: number): number {
  return (Math.floor(now / DAY_MS) - (retentionDays - 1)) * DAY_MS;
}

export interface CleanupDeps {
  now: () => number;
  retentionDays: number;
  batchSize?: number;
  sleep: (ms: number) => Promise<void>;
  /** Checked between batches; true ends the run after the batch in progress. */
  isAborted?: () => boolean;
  /** Deletes manual incidents resolved before the cutoff and returns how many. */
  deleteManualIncidents?: (cutoff: number) => number;
  /** Deletes latency rollups before the cutoff day and those of removed checks; returns how many. */
  deleteLatencyRollups?: (cutoff: number) => number;
  /** Deletes uptime tallies before the cutoff day and those of removed checks; returns how many. */
  deleteUptimeRollups?: (cutoff: number) => number;
}

/** Delete expired results in short batches, yielding between them, and resolved manual incidents of the same age. Returns the rows deleted. */
export async function cleanupResults(
  service: Pick<Service, "deleteExpiredResults">,
  {
    now,
    retentionDays,
    batchSize = RETENTION_BATCH_SIZE,
    sleep,
    isAborted = () => false,
    deleteManualIncidents,
    deleteLatencyRollups,
    deleteUptimeRollups,
  }: CleanupDeps,
): Promise<number> {
  const cutoff = retentionCutoff(now(), retentionDays);
  let total = deleteManualIncidents?.(cutoff) ?? 0;
  // Rollups follow the raw retention, which is never below the 90 days of the latency and uptime windows.
  total += deleteLatencyRollups?.(cutoff) ?? 0;
  total += deleteUptimeRollups?.(cutoff) ?? 0;
  for (;;) {
    const deleted = service.deleteExpiredResults(cutoff, batchSize);
    total += deleted;
    if (deleted < batchSize || isAborted()) return total;
    await sleep(0);
    if (isAborted()) return total;
  }
}

export interface RetentionDeps extends CleanupDeps {
  service: Pick<Service, "deleteExpiredResults">;
  /** The callback returns the run, so a fake clock can await it. */
  setTimeout: (fn: () => Promise<void>, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (message: string) => void;
  /** Time between runs; defaults to RETENTION_INTERVAL_MS. Tests shorten it. */
  intervalMs?: number;
}

export interface Retention {
  /** Stop scheduling runs and resolve when the run in progress (if any) has ended. */
  stop(): Promise<void>;
  /** Tell the run in progress to end after its current batch. */
  abort(): void;
  /** The run in progress, or the last one. */
  readonly done: Promise<void>;
}

/** Run cleanup now and then hourly. The next run is scheduled when one ends, so runs never overlap. */
export function startRetention(deps: RetentionDeps): Retention {
  let isStopped = false;
  let isAborted = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    // A timer that fires in the same tick as stop() must not start a run.
    if (isStopped) return Promise.resolve();
    current = (async (): Promise<void> => {
      try {
        const deleted = await cleanupResults(deps.service, {
          ...deps,
          isAborted: () => isAborted,
        });
        if (deleted > 0) deps.log(`retention: deleted ${deleted} results`);
      } catch (err) {
        deps.log(`retention failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
      if (!isStopped) {
        handle = deps.setTimeout(run, deps.intervalMs ?? RETENTION_INTERVAL_MS);
      }
    })();
    return current;
  };
  void run();
  return {
    get done() {
      return current;
    },
    stop() {
      isStopped = true;
      if (handle !== undefined) deps.clearTimeout(handle);
      return current;
    },
    abort() {
      isAborted = true;
    },
  };
}
