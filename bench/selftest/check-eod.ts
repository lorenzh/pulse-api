// Self-test of the pure parts of the end-of-day phase: the p95 of the samples, the near-midnight
// wait, the limit check of eod-read.ts, the checks file of the phase and the day-change retry.
import assert from "node:assert/strict";
import {
  EOD_METRICS,
  type EodResult,
  mustWaitForMidnight,
  nearestRankP95,
  overEodLimits,
  runEodPhase,
} from "../eod.ts";
import { eodChecksFileJson } from "../fixtures.ts";

// The p95 of 20 samples is the 19th smallest, in any order.
const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
assert.equal(nearestRankP95(twenty), 19);
assert.equal(nearestRankP95([7]), 7);
assert.throws(() => nearestRankP95([]), /no samples/);

// 00:09:59 UTC waits, 00:10:00 does not.
const midnight = Date.UTC(2026, 9, 31);
assert.equal(mustWaitForMidnight(midnight + 9 * 60_000 + 59_000), true);
assert.equal(mustWaitForMidnight(midnight + 10 * 60_000), false);
assert.equal(mustWaitForMidnight(midnight - 1), false, "23:59:59.999 is late in the day");

// The limit check: at the limit fails, below it does not; a metric missing on A never fails.
assert.deepEqual(overEodLimits({ eod_get_checks_ms: 392, eod_get_latency_ms: 10 }, 392, 53), [
  "eod_get_checks_ms",
]);
assert.deepEqual(overEodLimits({ eod_get_checks_ms: 391.9, eod_get_latency_ms: 10 }, 392, 53), []);
assert.deepEqual(overEodLimits({ eod_get_checks_ms: 1, eod_get_latency_ms: 53 }, 392, 53), [
  "eod_get_latency_ms",
]);
assert.deepEqual(overEodLimits({ eod_get_checks_ms: 1, eod_get_latency_ms: null }, 392, 53), []);

// The checks file of the phase: 20 checks and two components of 10 checks each.
const file = JSON.parse(eodChecksFileJson()) as {
  checks: { id: string }[];
  components: { id: string; checkIds: string[] }[];
};
assert.equal(file.checks.length, 20);
assert.deepEqual(
  file.components.map((c) => [c.id, c.checkIds.length]),
  [
    ["first", 10],
    ["second", 10],
  ],
);
assert.equal(file.components[0]?.checkIds[0], "c0");
assert.equal(file.components[1]?.checkIds[0], "c10");

assert.deepEqual(EOD_METRICS, [
  "eod_get_checks_ms",
  "eod_get_uptime_ms",
  "eod_get_latency_ms",
  "eod_get_check_latency_ms",
  "eod_get_components_ms",
  "eod_get_components_uptime_ms",
  "eod_read_cpu_ms",
]);

// The phase: waits before 00:10, repeats once when the day changes, fails on a second change.
const fake: EodResult = {
  eod_get_checks_ms: 1,
  eod_get_uptime_ms: 1,
  eod_get_latency_ms: 1,
  eod_get_check_latency_ms: 1,
  eod_get_components_ms: 1,
  eod_get_components_uptime_ms: 1,
  eod_read_cpu_ms: 1,
  medians: {},
  vm_rss_mib: 1,
  utc_start: "",
};
async function phase(times: number[]): Promise<{ seeds: number[]; slept: number[]; ok: boolean }> {
  const clock = [...times];
  let current = clock[0] ?? 0;
  const seeds: number[] = [];
  const slept: number[] = [];
  const now = (): number => {
    current = clock.shift() ?? current;
    return current;
  };
  try {
    await runEodPhase(
      {
        seed: (t) => {
          seeds.push(t);
          return Promise.resolve(518_400);
        },
        measure: () => Promise.resolve(fake),
      },
      () => undefined,
      now,
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );
    return { seeds, slept, ok: true };
  } catch {
    // The second day change is the expected failure of the last case.
    return { seeds, slept, ok: false };
  }
}
const noon = midnight + 43_200_000;
// One run: check time, seed time, end time.
assert.deepEqual(await phase([noon, noon, noon + 60_000]), { seeds: [noon], slept: [], ok: true });
// 00:05: waits five minutes first.
const five = midnight + 5 * 60_000;
const ten = midnight + 10 * 60_000;
assert.deepEqual(await phase([five, ten, ten + 60_000]), {
  seeds: [ten],
  slept: [300_000],
  ok: true,
});
// The day changes once: seeded again.
const late = midnight - 30_000;
const next = midnight + 11 * 60_000;
assert.deepEqual(await phase([late, late, midnight + 1, next, next, next + 1]), {
  seeds: [late, next],
  slept: [],
  ok: true,
});
// The day changes twice: a harness error.
assert.equal((await phase([late, late, midnight + 1, next, next, next + 86_400_000])).ok, false);
console.log("check-eod: ok");
