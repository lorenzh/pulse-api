// Self-test: a route whose commit side A lacks is reported, not compared; a 404 from a route A has fails.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Budgets, buildRows, EMITTED_METRICS, isFailure, renderTable } from "../compare.ts";
import { OPTIONAL_ROUTES, type Resets, routesMissingAt, timed } from "../load.ts";
import { runChecked } from "../measure.ts";
import { containsCommit } from "../refs.ts";

// The route check follows commit ancestry, not the text of server.ts.
const repo = await mkdtemp(join(tmpdir(), "bench-routes-"));
const git = (...args: string[]) =>
  runChecked("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
const commit = async (source: string): Promise<string> => {
  await writeFile(join(repo, "server.ts"), source);
  await git("add", "server.ts");
  await git("commit", "-q", "-m", "c");
  return (await git("rev-parse", "HEAD")).stdout.trim();
};
await git("init", "-q");
const before = await commit('const ROUTES = ["/checks"];\n');
const added = await commit('const ROUTES = ["/checks", "/latency"];\n');
await commit("const ROUTES = ['/checks', '/latency'];\n"); // formatting only
const routes = { "/latency": added };
const missingAtHead = () => routesMissingAt(routes, (c) => containsCommit(repo, c));
// A after the commit, with the route string reformatted: the route counts as present.
assert.deepEqual(await missingAtHead(), []);
// A before the commit: missing, so reported as not available on A.
await git("checkout", "-q", before);
assert.deepEqual(await missingAtHead(), ["/latency"]);
// A side branch that has the route string but not the commit: still missing.
await git("checkout", "-q", "-b", "side");
await commit('const ROUTES = ["/checks", "/latency"];\n// no handler\n');
assert.deepEqual(await missingAtHead(), ["/latency"]);
await assert.rejects(containsCommit(repo, "0".repeat(40)), /cannot fetch/);
await rm(repo, { recursive: true, force: true });
assert.deepEqual(Object.keys(OPTIONAL_ROUTES), ["/latency", "/checks/:id/latency"]);

// Every requested route must answer 200: a 404 from an A after the commit, or from B, fails.
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
