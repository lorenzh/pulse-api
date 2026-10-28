import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

async function start() {
  const service = createService(openDb(":memory:"));
  service.upsertChecks([
    { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 },
    { id: "c2", name: "C2", url: "http://y/", intervalMs: 1000, timeoutMs: 200 },
  ]);
  const server = createApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function result(checkId: string, timestamp: number, status: "up" | "down"): Result {
  return {
    checkId,
    timestamp,
    status,
    statusCode: status === "up" ? 200 : 500,
    latencyMs: 3,
    reason: status === "up" ? null : "HTTP 500",
  };
}

const post = (base: string, body: unknown, raw = false) =>
  fetch(`${base}/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });

test("server: POST /results 204, 400 and 404 cases", async () => {
  const { base, close } = await start();
  try {
    const okRes = await post(base, result("c1", 1, "up"));
    assert.equal(okRes.status, 204);

    const invalid: unknown[] = [
      [],
      { ...result("c1", 1, "up"), status: "maybe" },
      { ...result("c1", 1, "up"), timestamp: "1" },
      { ...result("c1", 1, "up"), latencyMs: -1 },
      { ...result("c1", 1, "up"), statusCode: "200" },
      { ...result("c1", 1, "up"), reason: 5 },
      { ...result("c1", 1, "up"), checkId: "" },
      { checkId: "c1" },
    ];
    for (const b of invalid) {
      const r = await post(base, b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(typeof ((await r.json()) as { error: string }).error, "string");
    }
    assert.equal((await post(base, "{nope", true)).status, 400);

    const missing = await post(base, result("nope", 1, "up"));
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /nope/);
  } finally {
    await close();
  }
});

test("server: GET /checks reflects state", async () => {
  const { base, close } = await start();
  try {
    let checks = (await (await fetch(`${base}/checks`)).json()) as any[];
    assert.deepEqual(
      checks.map((c) => [c.id, c.state]),
      [
        ["c1", "unknown"],
        ["c2", "unknown"],
      ],
    );
    assert.equal(checks[1].timeoutMs, 200);
    await post(base, result("c1", 10, "down"));
    checks = (await (await fetch(`${base}/checks`)).json()) as any[];
    assert.deepEqual(
      {
        s: checks[0].state,
        n: checks[0].consecutiveDown,
        t: checks[0].lastResultAt,
        r: checks[0].lastReason,
      },
      { s: "down", n: 1, t: 10, r: "HTTP 500" },
    );
  } finally {
    await close();
  }
});

test("server: GET /checks/:id/results ordering, limit, 404", async () => {
  const { base, close } = await start();
  try {
    for (let t = 1; t <= 5; t++) await post(base, result("c1", t, "up"));
    const all = (await (await fetch(`${base}/checks/c1/results`)).json()) as Result[];
    assert.deepEqual(
      all.map((r) => r.timestamp),
      [5, 4, 3, 2, 1],
    );
    const two = (await (await fetch(`${base}/checks/c1/results?limit=2`)).json()) as Result[];
    assert.deepEqual(
      two.map((r) => r.timestamp),
      [5, 4],
    );
    const huge = await fetch(`${base}/checks/c1/results?limit=999999`);
    assert.equal(huge.status, 200);
    assert.equal(((await huge.json()) as Result[]).length, 5);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      assert.equal((await fetch(`${base}/checks/c1/results?limit=${bad}`)).status, 400, bad);
    }
    assert.equal((await fetch(`${base}/checks/zzz/results`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/checks/c2/results`)).json(), []);
  } finally {
    await close();
  }
});

test("server: GET /incidents status filter and ordering", async () => {
  const { base, close } = await start();
  try {
    for (const t of [1, 2, 3]) await post(base, result("c1", t, "down"));
    for (const t of [4, 5, 6]) await post(base, result("c2", t, "down"));
    await post(base, result("c1", 7, "up"));

    const get = async (q: string) => (await (await fetch(`${base}/incidents${q}`)).json()) as any[];
    assert.deepEqual(
      (await get("?status=open")).map((i) => i.checkId),
      ["c2"],
    );
    const resolved = await get("?status=resolved");
    assert.deepEqual(
      resolved.map((i) => [i.checkId, i.openedAt, i.resolvedAt]),
      [["c1", 3, 7]],
    );
    const both = await get("");
    assert.deepEqual(
      both.map((i) => i.checkId),
      ["c2", "c1"],
    ); // open first
    const bad = await fetch(`${base}/incidents?status=bogus`);
    assert.equal(bad.status, 400);
    assert.equal(typeof ((await bad.json()) as { error: string }).error, "string");
  } finally {
    await close();
  }
});

test("server: unknown routes 404 and wrong methods 405", async () => {
  const { base, close } = await start();
  try {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/results`)).status, 405);
    assert.equal((await fetch(`${base}/checks`, { method: "POST" })).status, 405);
    const r = await fetch(`${base}/nope`);
    assert.equal(typeof ((await r.json()) as { error: string }).error, "string");
  } finally {
    await close();
  }
});
