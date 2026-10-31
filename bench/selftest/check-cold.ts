// Self-test of the pure parts of the cold-read phase: the seed row layout, the CPU settle rule
// and the limit check of cold-read.ts. Also runs bench/seed.ts twice with one explicit `now`.
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSettled, overLimit, seededLine, seedRowsOfMinute } from "../cold.ts";
import { runChecked } from "../measure.ts";

// Density 1: one row per minute, the 1x row of the load.
assert.deepEqual(seedRowsOfMinute(0, 1), [{ offsetMs: 0, status: "up", latencyMs: 5 }]);
assert.deepEqual(seedRowsOfMinute(3, 1), [{ offsetMs: 180_000, status: "up", latencyMs: 26 }]);

// Density 10: ten rows per minute, 6 s apart; row j = 0 equals the 1x row.
const minute = seedRowsOfMinute(3, 10);
assert.equal(minute.length, 10);
assert.deepEqual(minute[0], seedRowsOfMinute(3, 1)[0]);
assert.deepEqual(
  minute.map((r) => r.offsetMs),
  [180_000, 186_000, 192_000, 198_000, 204_000, 210_000, 216_000, 222_000, 228_000, 234_000],
);
// Index k * n + j = 97 at k = 9, j = 7: down. Index 0 (k = 0, j = 0) is the 1x row: up.
assert.equal(seedRowsOfMinute(9, 10)[7]?.status, "down");
assert.equal(seedRowsOfMinute(9, 10).filter((r) => r.status === "down").length, 1);
assert.equal(seedRowsOfMinute(0, 10)[0]?.status, "up");
assert.equal(seedRowsOfMinute(97, 1)[0]?.status, "up", "a 1x row is never down");
let downs = 0;
let rows = 0;
for (let k = 0; k < 43_200; k++) {
  for (const row of seedRowsOfMinute(k, 10)) {
    rows++;
    if (row.status === "down") downs++;
  }
}
assert.equal(rows, 432_000);
// Indexes 1 .. 431 999 divisible by 97, minus those with j = 0 (multiples of 970).
assert.equal(downs, 4453 - 445);

assert.equal(
  seededLine(864_000, 10_000, 1, 1_700_000_000_000),
  "seeded 864000 results (check interval 10000 ms, density 1, now 1700000000000)",
);

// Settle: less than 20 ms over the window.
assert.equal(isSettled(1000, 1019), true);
assert.equal(isSettled(1000, 1020), false);
assert.equal(isSettled(1000, 1000), true);

// Limit: 399 passes, 400 fails; each wall metric on its own; CPU is not a wall metric.
const fast = {
  cold_get_checks_ms: 399,
  cold_get_uptime_ms: 10,
  cold_read_cpu_ms: 5000,
  cold_concurrent_ms: 20,
};
assert.deepEqual(overLimit(fast, 400), []);
assert.deepEqual(overLimit({ ...fast, cold_get_checks_ms: 400 }, 400), ["cold_get_checks_ms"]);
assert.deepEqual(overLimit({ ...fast, cold_get_uptime_ms: 401 }, 400), ["cold_get_uptime_ms"]);
assert.deepEqual(overLimit({ ...fast, cold_concurrent_ms: 4000 }, 400), ["cold_concurrent_ms"]);

// seed.ts with an explicit now: the same timestamps on two runs, and the now in the last line.
const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pulse-check-cold-"));
try {
  const now = 1_700_000_012_345;
  const sample = async (name: string): Promise<{ line: string; rows: unknown[] }> => {
    const path = join(dir, name);
    const { stdout } = await runChecked("bun", [
      join(root, "bench/seed.ts"),
      root,
      path,
      "1",
      String(now),
    ]);
    const db = new Database(path, { readonly: true });
    const sampled = db
      .query(
        "SELECT check_id, timestamp, status, latency_ms FROM results WHERE id IN (1, 2, 43200, 864000) ORDER BY id",
      )
      .all();
    db.close();
    return { line: stdout.trim(), rows: sampled };
  };
  const first = await sample("one.db");
  const second = await sample("two.db");
  assert.equal(
    first.line,
    "seeded 864000 results (check interval 10000 ms, density 1, now 1700000012345)",
  );
  assert.deepEqual(first.rows, [
    { check_id: "c0", timestamp: now, status: "up", latency_ms: 5 },
    { check_id: "c0", timestamp: now - 60_000, status: "up", latency_ms: 12 },
    { check_id: "c0", timestamp: now - 43_199 * 60_000, status: "up", latency_ms: 298 },
    { check_id: "c19", timestamp: now - 43_199 * 60_000, status: "up", latency_ms: 298 },
  ]);
  assert.deepEqual(second, first);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("check-cold: ok");
