import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The outage gate of scripts/compose-e2e.sh, run on synthetic histories.
const SCRIPT = fileURLToPath(new URL("../scripts/outage-history.sh", import.meta.url));
const START = 100_000;
const END = 135_000;
const INTERVAL = 10_000;

function covers(timestamps: number[], location = "east"): boolean {
  const results = timestamps.map((timestamp) => ({ timestamp, location }));
  const run = spawnSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test runs the script with the host bash
    "bash",
    ["-c", `source "$0" && history_covers_outage ${START} ${END} ${INTERVAL}`, SCRIPT],
    { input: JSON.stringify(results.toReversed()) },
  );
  return run.status === 0;
}

const steady = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let t = from; t <= to; t += INTERVAL) out.push(t);
  return out;
};

test("outage gate: a replayed history every interval passes", () => {
  assert.equal(covers(steady(85_000, 175_000)), true);
});

test("outage gate: no result inside the outage fails, even with fresh results after it", () => {
  assert.equal(covers([...steady(60_000, 95_000), 136_000, 146_000, 156_000]), false);
});

test("outage gate: a gap above 1.5 x the interval inside the window fails", () => {
  assert.equal(covers([...steady(85_000, 115_000), ...steady(135_000, 175_000)]), false);
});

test("outage gate: history that stops before the window end fails", () => {
  assert.equal(covers(steady(85_000, 125_000)), false);
});

test("outage gate: a repeated timestamp fails", () => {
  assert.equal(covers([...steady(85_000, 175_000), 115_000]), false);
});
