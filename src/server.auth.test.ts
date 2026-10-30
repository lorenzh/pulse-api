import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ErrorResponse, ResultsResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const A = "token-a-0123456789abcdef";
const B = "token-b-0123456789abcdef";

const service = createService(openDb(":memory:"));
service.upsertChecks([
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
  { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 },
]);
const server = createApiServer(service, {
  tokens: [
    { location: "east", token: A },
    { location: "west", token: B },
  ],
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

const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    checkId: "c1",
    timestamp: 1,
    status: "up",
    statusCode: 200,
    latencyMs: 3,
    reason: null,
    attempts: 1,
    ...extra,
  });

const post = (authorization: string | undefined, payload: string = body()) =>
  fetch(`${base}/results`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: payload,
  });

function stored(): ResultsResponse {
  return service.listResults("c1", 100);
}

async function assertUnauthorized(res: Response): Promise<void> {
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), "Bearer");
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "unauthorized" });
  assert.ok(!text.includes(A) && !text.includes(B));
}

test("auth: missing, wrong, malformed and empty tokens are 401 and store nothing", async () => {
  for (const header of [
    undefined,
    "Bearer wrong",
    `Basic ${A}`,
    A,
    "Bearer",
    "Bearer ",
    `Bearer  ${A}`,
  ]) {
    await assertUnauthorized(await post(header));
  }
  assert.equal(stored().length, 0);
});

test("auth: 401 beats 400 and 404", async () => {
  await assertUnauthorized(await post(undefined, "not json"));
  await assertUnauthorized(await post("Bearer wrong", body({ checkId: "nope" })));
  assert.equal(stored().length, 0);
});

test("auth: method check still comes first", async () => {
  assert.equal((await fetch(`${base}/results`)).status, 405);
});

test("auth: token for another location is 403 and stores nothing", async () => {
  const res = await post(`Bearer ${A}`, body({ location: "west" }));
  assert.equal(res.status, 403);
  const err = (await res.json()) as ErrorResponse;
  assert.deepEqual(err, { error: "location does not match token" });
  assert.equal(stored().length, 0);
  assert.equal(service.listChecks()[0]?.state, "unknown");
});

test("auth: matching or omitted location is 204 and stored under the token location", async () => {
  assert.equal((await post(`Bearer ${A}`, body({ location: " east " }))).status, 204);
  assert.equal((await post(`bearer ${B}`, body({ timestamp: 2 }))).status, 204);
  assert.equal((await post(`Bearer ${A}`, body({ timestamp: 3, location: " " }))).status, 204);
  const locations = stored().map((r) => `${r.timestamp}:${r.location}`);
  assert.deepEqual(
    locations.toSorted((a, b) => a.localeCompare(b)),
    ["1:east", "2:west", "3:east"],
  );
});

test("auth: validation and unknown checks still answer 400 and 404 with a valid token", async () => {
  assert.equal((await post(`Bearer ${A}`, "not json")).status, 400);
  assert.equal((await post(`Bearer ${A}`, body({ checkId: "nope" }))).status, 404);
});

test("auth: read routes are public", async () => {
  for (const path of ["/checks", "/incidents", "/uptime", "/maintenance", "/checks/c1/results"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
});
