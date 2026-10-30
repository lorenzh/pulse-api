// Self-test: a route that side A answers with 404 is reported, not compared; side B must serve it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type Budgets, buildRows, EMITTED_METRICS, isFailure, renderTable } from "../compare.ts";
import { type Resets, timed } from "../load.ts";

const statusOf: Record<string, number> = { "/old": 200, "/new": 404, "/broken": 500 };
const server = createServer((req, res) => {
  res.writeHead(statusOf[req.url ?? ""] ?? 404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const resets: Resets = { retriedGets: 0, droppedPosts: 0 };

// Side A (404 allowed): the new route is missing, the old one measured, any other status fails.
const aSamples: number[] = [];
assert.equal(await timed(`${base}/new`, {}, 200, aSamples, resets, true), false);
assert.equal(aSamples.length, 0);
assert.equal(await timed(`${base}/old`, {}, 200, aSamples, resets, true), true);
assert.equal(aSamples.length, 1);
await assert.rejects(timed(`${base}/broken`, {}, 200, undefined, resets, true), /status 500/);
// Side B (strict): a 404 fails the run.
await assert.rejects(timed(`${base}/new`, {}, 200, undefined, resets), /GET .*\/new: status 404/);
server.close();

// A without the latency metric, B with it: one reported row, no failure.
const budgets: Budgets = {};
const a: Record<string, Record<string, number[]>> = {};
const b: Record<string, Record<string, number[]>> = {};
for (const [service, metrics] of Object.entries(EMITTED_METRICS)) {
  budgets[service] = {};
  a[service] = {};
  b[service] = {};
  for (const metric of metrics) {
    budgets[service][metric] = { budget: 100, unit: "ms", gating: true };
    a[service][metric] = [10];
    b[service][metric] = [10];
  }
}
delete a.api?.p95_get_latency_ms;
const rows = buildRows(budgets, a, b, new Set(["api.p95_get_latency_ms"]));
const row = rows.find((r) => r.metric === "p95_get_latency_ms");
assert.deepEqual([row?.a, row?.b, row?.verdict], [null, 10, "not available on A"]);
assert.equal(rows.filter((r) => isFailure(r.verdict)).length, 0);
assert.match(
  renderTable(rows),
  /\| `p95_get_latency_ms` \| n\/a \| 10\.00 ms \| n\/a \|.*not available on A \|/,
);
// Without the 404 mark a missing A metric still fails, and B can never lack one.
assert.throws(() => buildRows(budgets, a, b), /missing metric api\.p95_get_latency_ms/);
delete b.api?.p95_get_latency_ms;
assert.throws(
  () => buildRows(budgets, a, b, new Set(["api.p95_get_latency_ms"])),
  /missing metric api\.p95_get_latency_ms/,
);
console.log("check-missing-route: ok");
