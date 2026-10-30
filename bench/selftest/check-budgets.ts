// Self-test: budgets.json is valid and has an entry for every metric the harness emits.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EMITTED_METRICS, missingBudgets, parseBudgets } from "../compare.ts";
import { REPOS } from "../refs.ts";

const budgets = parseBudgets(
  JSON.parse(await readFile(new URL("../budgets.json", import.meta.url), "utf8")),
);
assert.deepEqual(missingBudgets(budgets, EMITTED_METRICS), []);
assert.deepEqual(missingBudgets({}, { api: ["rps"] }), ["api.rps"]);
for (const [service, metrics] of Object.entries(budgets)) {
  for (const [metric, entry] of Object.entries(metrics)) {
    assert.ok(
      EMITTED_METRICS[service]?.includes(metric as never),
      `${service}.${metric} is never emitted`,
    );
    if (service === "contract" || service === "kit" || service === "config") {
      assert.equal(entry.gating, true, `${service}.${metric} must gate`);
    }
  }
}
const baseline = JSON.parse(
  await readFile(new URL("../baseline.json", import.meta.url), "utf8"),
) as Record<string, string>;
for (const name of REPOS)
  assert.match(baseline[name] ?? "", /^[0-9a-f]{40}$/, `baseline.json: ${name}`);
console.log("check-budgets: ok");
