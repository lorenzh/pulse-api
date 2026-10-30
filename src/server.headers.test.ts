import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const TOKEN = "header-token-0123456789abcdef";
const service = createService(openDb(":memory:"));
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
service.upsertChecks([{ id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 }]);
const server = createApiServer(service, {
  tokens: [{ location: "default", token: TOKEN }],
  now: () => 1000,
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
});

const good = {
  checkId: "c1",
  timestamp: 1000,
  status: "up",
  statusCode: 200,
  latencyMs: 1,
  reason: null,
};

function post(body: string, auth = true): Promise<Response> {
  return fetch(`${base}/results`, {
    method: "POST",
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    body,
  });
}

function assertHeaders(res: Response, label: string): void {
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", label);
  assert.equal(
    res.headers.get("content-security-policy"),
    "default-src 'none'; frame-ancestors 'none'",
    label,
  );
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", label);
}

test("security headers are on 200, 204, 400, 401, 404, 405, 413 and OPTIONS responses", async () => {
  const cases: [string, Response][] = [
    ["200", await fetch(`${base}/checks`)],
    ["204", await post(JSON.stringify(good))],
    ["400", await post("{")],
    ["401", await post(JSON.stringify(good), false)],
    ["404", await fetch(`${base}/nope`)],
    ["405", await fetch(`${base}/checks`, { method: "DELETE" })],
    ["413", await post("x".repeat(1_000_001))],
    ["OPTIONS", await fetch(`${base}/checks`, { method: "OPTIONS" })],
  ];
  for (const [label, res] of cases) {
    await res.arrayBuffer();
    assertHeaders(res, label);
  }
  assert.equal(cases[1]?.[1].status, 204);
  assert.equal(cases[3]?.[1].headers.get("www-authenticate"), "Bearer");
});

test("x-pulse-contract carries the wire version on 200, 204, 400 and 404 responses", async () => {
  const cases: Response[] = [
    await fetch(`${base}/checks`),
    await post(JSON.stringify(good)),
    await post("{"),
    await fetch(`${base}/nope`),
  ];
  assert.deepEqual(
    cases.map((r) => r.status),
    [200, 204, 400, 404],
  );
  for (const res of cases) {
    await res.arrayBuffer();
    assert.equal(res.headers.get(WIRE_VERSION_HEADER), String(WIRE_VERSION));
  }
});
