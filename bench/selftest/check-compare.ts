// Self-test of the failure rule, the table and the budgets schema. Run: bun run bench:selftest
import assert from "node:assert/strict";
import { type Budget, judge, parseBudgets, renderTable } from "../compare.ts";

const cpu: Budget = { budget: 5, unit: "s", gating: true };
assert.equal(judge(1, 1.1, cpu), "ok", "within the floor");
assert.equal(judge(1, 1.3, cpu), "FAIL regression", "above 10 % and the 0.2 s floor");
assert.equal(judge(10, 10.5, { ...cpu, budget: 100 }), "ok", "above the floor but below 10 %");
assert.equal(judge(10, 11.5, { ...cpu, budget: 100 }), "FAIL regression");
assert.equal(judge(1, 0.1, cpu), "ok", "an improvement never fails");
assert.equal(judge(5.1, 5.1, cpu), "FAIL budget", "over budget without a regression");
assert.equal(judge(1, 99, { ...cpu, gating: false }), "reported");
assert.equal(judge(100, 125, { budget: 500, unit: "MiB", gating: true }), "FAIL regression");
assert.equal(judge(100, 102, { budget: 500, unit: "MiB", gating: true }), "ok", "3 MiB floor");
assert.equal(
  judge(1, 1.15, { ...cpu, floor: 0.01, thresholdPct: 20 }),
  "ok",
  "per-metric override",
);
assert.equal(judge(1, 1.3, { ...cpu, floor: 0.01, thresholdPct: 20 }), "FAIL regression");

const table = renderTable([
  { service: "api", metric: "load_cpu_s", a: 1, b: 1.5, budget: cpu, verdict: "FAIL regression" },
  {
    service: "api",
    metric: "rps",
    a: 40,
    b: 41,
    budget: { budget: 1, unit: "req/s", gating: false },
    verdict: "reported",
  },
]);
assert.match(table, /\| `load_cpu_s` .* FAIL regression \|/);
assert.match(table, /### api/);

assert.throws(() => parseBudgets({ api: { nope: cpu } }), /unknown metric/);
assert.throws(() => parseBudgets({ api: { load_cpu_s: { ...cpu, unit: "kg" } } }), /unit/);
assert.throws(() => parseBudgets({ api: { load_cpu_s: { ...cpu, extra: 1 } } }), /unknown key/);
assert.throws(() => parseBudgets({ api: { load_cpu_s: { budget: 1, unit: "s" } } }), /gating/);
assert.deepEqual(parseBudgets({ api: { load_cpu_s: cpu } }), { api: { load_cpu_s: cpu } });
console.log("check-compare: ok");
