import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckLocationUptime, ErrorResponse, Result } from "@lorenzh/pulse-contract";
import { validateCheckLocationUptime } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const URL_X = "http://x/";

function result(checkId: string, timestamp: number, location: string, isUp: boolean): Result {
  return {
    checkId,
    timestamp,
    status: isUp ? "up" : "down",
    statusCode: null,
    latencyMs: 1,
    reason: null,
    location,
    attempts: 1,
  };
}

let dir = "";
let base = "";
let port = 0;
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-location-uptime-"));
  const db = openDb(join(dir, "pulse.db"));
  const service = createService(db, { now: () => NOW });
  service.upsertChecks([
    { id: "c1", name: "C1", url: URL_X, intervalMs: 1000 },
    { id: "a/b", name: "AB", url: URL_X, intervalMs: 1000 },
    { id: ".", name: "Dot", url: URL_X, intervalMs: 1000 },
    { id: "old", name: "Old", url: URL_X, intervalMs: 1000 },
  ]);
  for (const id of ["c1", "a/b", ".", "old"]) {
    service.ingest(result(id, NOW - 3 * DAY, "eu", true));
    service.ingest(result(id, NOW - 2 * DAY, "eu", false));
    service.ingest(result(id, NOW - DAY, "us", true));
  }
  // "old" stays in the database but is no longer in the checks file.
  service.upsertChecks([
    { id: "c1", name: "C1", url: URL_X, intervalMs: 1000 },
    { id: "a/b", name: "AB", url: URL_X, intervalMs: 1000 },
    { id: ".", name: "Dot", url: URL_X, intervalMs: 1000 },
  ]);
  const server = createApiServer(service, { now: () => NOW });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
});

afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED = {
  locations: [
    { location: "eu", good: 1, results: 2, uptime: 50 },
    { location: "us", good: 1, results: 1, uptime: 100 },
  ],
};

async function getTyped(path: string, init?: RequestInit): Promise<CheckLocationUptime> {
  const res = await fetch(`${base}${path}`, init);
  assert.equal(res.status, 200, path);
  const body: unknown = await res.json();
  const v = validateCheckLocationUptime(body);
  assert.ok(v.ok, v.ok ? path : v.error);
  return v.value;
}

function pick(v: CheckLocationUptime): unknown {
  return {
    locations: v.locations.map((l) => ({
      location: l.location,
      good: l.good,
      results: l.results,
      uptime: l.uptime,
    })),
  };
}

test("GET /checks/:id/location-uptime answers 200 typed by the contract", async () => {
  assert.deepEqual(pick(await getTyped("/checks/c1/location-uptime")), EXPECTED);
});

test("an encoded id a/b is served", async () => {
  assert.deepEqual(pick(await getTyped("/checks/a%2Fb/location-uptime")), EXPECTED);
});

test("the route is public: an irrelevant Bearer header is not authenticated", async () => {
  const v = await getTyped("/checks/c1/location-uptime", {
    headers: { authorization: "Bearer not-a-token" },
  });
  assert.deepEqual(pick(v), EXPECTED);
});

test("unknown and inactive checks answer 404 unknown check", async () => {
  for (const id of ["nope", "old"]) {
    const res = await fetch(`${base}/checks/${id}/location-uptime`);
    assert.equal(res.status, 404, id);
    assert.deepEqual((await res.json()) as ErrorResponse, { error: "unknown check" });
  }
});

test("a bad escape answers 400 bad check id", async () => {
  const res = await fetch(`${base}/checks/%E0%A4%A/location-uptime`);
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()) as ErrorResponse, { error: "bad check id" });
});

test("the metric route label is /checks/:id/location-uptime", async () => {
  await fetch(`${base}/checks/c1/location-uptime`);
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(
    text,
    /pulse_api_http_requests_total\{route="\/checks\/:id\/location-uptime",code="200"\}/,
  );
  assert.equal(text.includes("/checks/c1/"), false);
});

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the ids . and .. cannot be addressed: the path is normalized first", async () => {
  const dot = await rawGet("/checks/%2E/location-uptime");
  assert.equal(dot.status, 404);
  assert.deepEqual(JSON.parse(dot.body), { error: "not found" });
  const up = await rawGet("/checks/../results");
  assert.equal(up.status, 405);
});
