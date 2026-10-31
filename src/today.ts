/** An ascending list of numbers in a `Float64Array` with spare capacity. */
export interface SortedValues {
  data: Float64Array;
  length: number;
}

/** Good and total results of one check on one UTC day. */
export interface UptimeToday {
  day: number;
  good: number;
  total: number;
}

/** The ascending latencies of one check on one UTC day. */
export interface LatencyToday {
  day: number;
  values: SortedValues;
}

/** One row that `ingest` stored, as today's state needs it. */
export interface StoredSample {
  checkId: string;
  day: number;
  isDown: boolean;
  latencyMs: number;
}

const MIN_CAPACITY = 16;

/**
 * A sorted list of `values`. Ascending input (as `ORDER BY` returns it) is appended without a
 * search, and the capacity keeps room for more inserts.
 */
export function sortedFrom(values: Iterable<number>): SortedValues {
  const sorted: SortedValues = { data: new Float64Array(MIN_CAPACITY), length: 0 };
  for (const value of values) insertSorted(sorted, value);
  return sorted;
}

/** The values in use, without the spare capacity. A view, not a copy. */
export function sortedView(values: SortedValues): Float64Array {
  return values.data.subarray(0, values.length);
}

/** The first index whose value is greater than `value`: equal values keep their order. */
function upperBound(values: SortedValues, value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((values.data[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Insert `value` at its sorted position; the capacity doubles when it is full. */
export function insertSorted(values: SortedValues, value: number): void {
  if (values.length === values.data.length) {
    const grown = new Float64Array(Math.max(MIN_CAPACITY, values.data.length * 2));
    grown.set(values.data);
    values.data = grown;
  }
  const last = values.data[values.length - 1];
  const at = last === undefined || value >= last ? values.length : upperBound(values, value);
  values.data.copyWithin(at + 1, at, values.length);
  values.data[at] = value;
  values.length += 1;
}

/**
 * Today's state of every check: the uptime tally and the latencies of one UTC day, built from the
 * results by the reader and then updated after each committed insert.
 */
export interface TodayState {
  uptime: Map<string, UptimeToday>;
  latency: Map<string, LatencyToday>;
}

export function emptyTodayState(): TodayState {
  return { uptime: new Map(), latency: new Map() };
}

/** Drop the records of days before `today` of all checks, which releases their memory. */
export function dropOlderDays(state: TodayState, today: number): void {
  for (const [id, record] of state.uptime) if (record.day < today) state.uptime.delete(id);
  for (const [id, record] of state.latency) if (record.day < today) state.latency.delete(id);
}

/** Count a stored row in the records of its day. A row of another day, or a check without a record, is dropped. */
export function applyStored(state: TodayState, sample: StoredSample): void {
  const uptime = state.uptime.get(sample.checkId);
  if (uptime !== undefined && uptime.day === sample.day) {
    uptime.total += 1;
    if (!sample.isDown) uptime.good += 1;
  }
  if (sample.isDown) return;
  const latency = state.latency.get(sample.checkId);
  if (latency !== undefined && latency.day === sample.day) {
    insertSorted(latency.values, sample.latencyMs);
  }
}
