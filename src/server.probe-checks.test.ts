import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Check, CheckWithState } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const TOKEN = "token-a-0123456789abcdef";
const HEADER_SECRET = "literal-header-sentinel";
const ENV_NAME = "SVC_TOKEN_SENTINEL";
const BODY_SECRET = "body-sentinel";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const URL_X = "http://x/";

const checks: Check[] = [
  {
    id: "post",
    name: "Post",
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    url: "http://x/",
    intervalMs: 1000,
    retries: 0,
    retryDelayMs: 1000,
    method: "POST",
    headers: { "X-Key": HEADER_SECRET, Authorization: { env: ENV_NAME } },
    body: `{"v":"${BODY_SECRET}"}`,
    expectedStatus: [200, "300-399"],
    jsonAssert: [{ pointer: "/status", equals: "ok" }],
  },
  {
    id: "plain",
    name: "Plain",
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    url: "http://x/",
    intervalMs: 1000,
    retries: 0,
    retryDelayMs: 1000,
    method: "GET",
    expectedStatus: ["200-299"],
  },
  {
    id: "tls",
    name: "Tls",
    type: "tls",
    host: "example.com",
    port: 443,
    warnDays: 14,
    intervalMs: 1000,
  },
];

const service = createService(openDb(":memory:"), { now: () => 1000 });
service.upsertChecks(checks);
const server = createApiServer(service, {
  tokens: [{ location: "east", token: TOKEN }],
  now: () => 1000,
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

test("GET /probe/checks needs the probe token", async () => {
  assert.equal((await fetch(`${base}/probe/checks`)).status, 401);
  const wrong = await fetch(`${base}/probe/checks`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("www-authenticate"), "Bearer");
  const post = await fetch(`${base}/probe/checks`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(post.status, 405);
});

test("GET /probe/checks serves the request options as written, without state", async () => {
  const res = await fetch(`${base}/probe/checks`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Check[];
  assert.deepEqual(body, checks);
});

test("GET /checks omits headers, body and assertions and the default options", async () => {
  const res = await fetch(`${base}/checks`);
  const text = await res.text();
  for (const secret of [HEADER_SECRET, ENV_NAME, BODY_SECRET, "jsonAssert", "headers", '"body"']) {
    assert.ok(!text.includes(secret), secret);
  }
  const body = JSON.parse(text) as CheckWithState[];
  const post = body.find((c) => c.id === "post");
  assert.ok(post && post.type !== "tls" && post.type !== "heartbeat");
  assert.equal(post.method, "POST");
  assert.deepEqual(post.expectedStatus, [200, "300-399"]);
  const plain = body.find((c) => c.id === "plain");
  assert.ok(plain && plain.type !== "tls" && plain.type !== "heartbeat");
  assert.equal(plain.method, undefined);
  assert.equal(plain.expectedStatus, undefined);
});

test("/metrics never holds a header value, an env name or a body", async () => {
  const probe = await fetch(`${base}/probe/checks`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  // The secrets are stored and served to probes, so their absence below is not vacuous.
  assert.deepEqual(await probe.json(), checks);
  await fetch(`${base}/checks`);
  const text = await (await fetch(`${base}/metrics`)).text();
  for (const secret of [HEADER_SECRET, ENV_NAME, BODY_SECRET]) assert.ok(!text.includes(secret));
});

test("upsert clears the request options of a check that lost them", () => {
  const db = openDb(":memory:");
  const s = createService(db, { now: () => 1000 });
  s.upsertChecks(checks);
  s.upsertChecks([{ id: "post", name: "Post", url: URL_X, intervalMs: 1000 }]);
  const [only] = s.listProbeChecks();
  assert.deepEqual(only, {
    id: "post",
    name: "Post",
    url: URL_X,
    intervalMs: 1000,
    retries: 0,
    retryDelayMs: 1000,
  });
  s.upsertChecks([]);
  const row = db.prepare("SELECT method, headers_json, body FROM checks WHERE id = 'plain'").get();
  assert.deepEqual({ ...row }, { method: null, headers_json: null, body: null });
});
