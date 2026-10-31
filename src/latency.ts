import type { CheckLatency, LatencyDay } from "@lorenzh/pulse-contract";

export const LATENCY_DAYS = 90;
const DAY_MS = 86_400_000;

/** The daily figures of one check as stored in `latency_daily`. */
export interface LatencyRollup {
  p50Ms: number | null;
  p95Ms: number | null;
  count: number;
}

export const EMPTY_ROLLUP: LatencyRollup = { p50Ms: null, p95Ms: null, count: 0 };

/**
 * Nearest-rank percentile of an ascending list: the value at 1-based index `ceil(percent * n / 100)`,
 * no interpolation. `percent` is an integer 1..100. Null for an empty list.
 */
export function nearestRank(sorted: ArrayLike<number>, percent: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percent * sorted.length) / 100));
  return sorted[rank - 1] ?? null;
}

/** p50 and p95 of one day's latencies (ascending). */
export function summarizeLatencies(sorted: ArrayLike<number>): LatencyRollup {
  return { p50Ms: nearestRank(sorted, 50), p95Ms: nearestRank(sorted, 95), count: sorted.length };
}

/** The UTC day number (days since the epoch) of an instant. */
export function dayOf(t: number): number {
  return Math.floor(t / DAY_MS);
}

/** The 90 day numbers ending at `today`, oldest first. */
export function latencyWindow(today: number): number[] {
  return Array.from({ length: LATENCY_DAYS }, (_, i) => today - (LATENCY_DAYS - 1) + i);
}

/** The 90-day history of a check; a day without a rollup row is empty. */
export function buildCheckLatency(
  checkId: string,
  today: number,
  rollups: ReadonlyMap<number, LatencyRollup>,
): CheckLatency {
  const days = latencyWindow(today).map((day): LatencyDay => {
    const rollup = rollups.get(day) ?? EMPTY_ROLLUP;
    return { date: new Date(day * DAY_MS).toISOString().slice(0, 10), ...rollup };
  });
  return { checkId, days };
}
