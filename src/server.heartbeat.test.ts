import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { ChecksResponse, ErrorResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const SECRET = "hb-secret-0123456789abcdef";
const TOKEN = "probe-token-0123456789abcdef";
const NOW = 1_000_000;

const metrics = createMetrics();
const errors: string[] = [];
const service = createService(openDb(":memory:"), { now: () => NOW });
service.upsertChecks([
  { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 },
  { id: "off", name: "Off", type: "heartbeat", period: 60000, grace: 0 },
]);
service.upsertChecks([{ id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 }]);
const server = createApiServer(service, {
  tokens: [{ location: "east", token: TOKEN }],
  heartbeatSecrets: new Map([
    ["job", SECRET],
    ["off", "other-secret-0123456789abc"],
  ]),
  metrics,
  now: () => NOW,
  logError: (m, err) => errors.push(`${m} ${String(err)}`),
});
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
});

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

test("header form: POST and GET answer 204 and record an up result", async () => {
  for (const method of ["POST", "GET"]) {
    const r = await fetch(`${base}/heartbeat/job`, { method, headers: bearer(SECRET) });
    assert.equal(r.status, 204);
    assert.equal(await r.text(), "");
  }
  const results = service.listResults("job", 10);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    checkId: "job",
    timestamp: NOW,
    status: "up",
    statusCode: null,
    latencyMs: 0,
    reason: null,
    location: "heartbeat",
    attempts: 1,
  });
  const checks = service.listChecks();
  assert.equal(checks[0]?.state, "up");
  assert.equal(checks[0]?.lastResultAt, NOW);
});

test("path form works and the id is URL-decoded", async () => {
  const r = await fetch(`${base}/heartbeat/job/${SECRET}`, { method: "POST" });
  assert.equal(r.status, 204);
});

test("401 bodies are identical for wrong secret, missing secret and unknown id", async () => {
  const attempts: [string, Record<string, string>][] = [
    ["/heartbeat/job", bearer("wrong-secret-0123456789ab")],
    ["/heartbeat/job", {}],
    ["/heartbeat/nope", bearer(SECRET)],
    ["/heartbeat/nope/wrong-secret-0123456789ab", {}],
    ["/heartbeat/job/wrong-secret-0123456789ab", {}],
    ["/heartbeat/%E0%A4%A", bearer(SECRET)],
    ["/heartbeat/job", bearer(TOKEN)],
  ];
  const before = service.listResults("job", 100).length;
  const bodies = new Set<string>();
  for (const [path, headers] of attempts) {
    const r = await fetch(`${base}${path}`, { headers });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    const body = (await r.json()) as ErrorResponse;
    bodies.add(JSON.stringify(body));
  }
  assert.deepEqual([...bodies], ['{"error":"unauthorized"}']);
  assert.equal(service.listResults("job", 100).length, before);
});

test("other methods answer 405 and a large body 413", async () => {
  const put = await fetch(`${base}/heartbeat/job`, { method: "PUT", headers: bearer(SECRET) });
  assert.equal(put.status, 405);
  const small = await fetch(`${base}/heartbeat/job`, {
    method: "POST",
    headers: bearer(SECRET),
    body: "x".repeat(1024),
  });
  assert.equal(small.status, 204);
  const big = await fetch(`${base}/heartbeat/job`, {
    method: "POST",
    headers: bearer(SECRET),
    body: "x".repeat(1025),
  });
  assert.equal(big.status, 413);
});

test("a ping to an inactive check answers 204 and records nothing", async () => {
  const r = await fetch(`${base}/heartbeat/off`, { headers: bearer("other-secret-0123456789abc") });
  assert.equal(r.status, 204);
  assert.equal(service.listResults("off", 10).length, 0);
  assert.doesNotMatch(metrics.render([]), /pulse_heartbeat_pings_total\{check="off"\}/);
});

test("a probe token cannot ping and the ping secret cannot post /results", async () => {
  const ping = await fetch(`${base}/heartbeat/job`, { headers: bearer(TOKEN) });
  assert.equal(ping.status, 401);
  const post = await fetch(`${base}/results`, {
    method: "POST",
    headers: bearer(SECRET),
    body: JSON.stringify({
      checkId: "job",
      timestamp: NOW,
      status: "up",
      statusCode: null,
      latencyMs: 0,
      reason: null,
    }),
  });
  assert.equal(post.status, 401);
});

test("GET /checks never serves the secret", async () => {
  const text = await (await fetch(`${base}/checks`)).text();
  assert.equal(text.includes(SECRET), false);
  const checks = JSON.parse(text) as ChecksResponse;
  const c = checks[0];
  assert.ok(c !== undefined && c.type === "heartbeat");
  assert.equal(c.period, 60000);
  assert.equal(c.grace, 0);
  assert.equal("url" in c, false);
  assert.equal("intervalMs" in c, false);
});

test("metrics count accepted pings; route label has no id or secret; no secret in logs", async () => {
  await fetch(`${base}/heartbeat/job/${SECRET}`);
  await fetch(`${base}/heartbeat/job/bad-secret-0123456789abc`);
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /pulse_heartbeat_pings_total\{check="job"\} \d+/);
  assert.match(text, /pulse_api_http_requests_total\{route="\/heartbeat\/:id",code="204"\}/);
  assert.match(text, /pulse_api_http_requests_total\{route="\/heartbeat\/:id",code="401"\}/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("bad-secret"), false);
  assert.equal(errors.join("\n").includes(SECRET), false);
});
