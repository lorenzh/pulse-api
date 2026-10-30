// Self-test: a route side A's source lacks is reported, not compared; a 404 from a route that exists fails.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type Budgets, buildRows, EMITTED_METRICS, isFailure, renderTable } from "../compare.ts";
import { type Resets, routesMissingFrom, timed } from "../load.ts";

// Capability check from A's route table: only a route its source lacks is skipped on A.
const oldApi = 'const ROUTES = ["/checks", "/uptime", "/components/uptime"];';
const newApi = `const ROUTES = ["/checks", "/uptime", "/latency"];\n  return "/checks/:id/latency";`;
assert.deepEqual(routesMissingFrom(oldApi), ["/latency", "/checks/:id/latency"]);
assert.deepEqual(routesMissingFrom(newApi), []);
assert.deepEqual(routesMissingFrom('"/latency"'), ["/checks/:id/latency"]);

// Every requested route must answer 200: a 404 from an A that has the route, or from B, fails.
const server = createServer((req, res) => {
  res.writeHead(req.url === "/old" ? 200 : 404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const resets: Resets = { retriedGets: 0, droppedPosts: 0 };
const samples: number[] = [];
await timed(`${base}/old`, {}, 200, samples, resets);
assert.equal(samples.length, 1);
await assert.rejects(
  timed(`${base}/latency`, {}, 200, samples, resets),
  /GET .*\/latency: status 404/,
);
assert.equal(samples.length, 1);
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
