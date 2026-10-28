import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService, UnknownCheckError } from "./service.ts";

const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000, timeoutMs: 500 };

export function res(t: number, status: "up" | "down", reason: string | null = null): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status,
    statusCode: status === "up" ? 200 : 503,
    latencyMs: 5,
    reason: status === "down" ? (reason ?? "HTTP 503") : null,
    location: "default",
  };
}

test("service: unknown state before any result", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  assert.deepEqual(s.listChecks(), [
    {
      ...check,
      state: "unknown",
      consecutiveDown: 0,
      lastResultAt: null,
      lastReason: null,
      locations: [],
    },
  ]);
});

test("service: incident opens on 3rd down with that result's timestamp and reason, resolves on up", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  s.ingest(res(1, "down", "a"));
  s.ingest(res(2, "down", "b"));
  assert.deepEqual(s.listIncidents(), []);
  s.ingest(res(3, "down", "c"));
  s.ingest(res(4, "down", "d"));
  assert.deepEqual(s.listIncidents("open"), [
    { id: 1, checkId: "c1", openedAt: 3, resolvedAt: null, reason: "c" },
  ]);
  assert.equal(s.listChecks()[0]!.state, "down");
  assert.equal(s.listChecks()[0]!.consecutiveDown, 4);
  s.ingest(res(5, "up"));
  assert.deepEqual(s.listIncidents("open"), []);
  assert.deepEqual(s.listIncidents("resolved"), [
    { id: 1, checkId: "c1", openedAt: 3, resolvedAt: 5, reason: "c" },
  ]);
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.equal(s.listChecks()[0]!.consecutiveDown, 0);
});

test("service: up-down-down-up opens nothing; second incident after recovery", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const [t, st] of [
    [1, "up"],
    [2, "down"],
    [3, "down"],
    [4, "up"],
  ] as const)
    s.ingest(res(t, st));
  assert.deepEqual(s.listIncidents(), []);
  for (const t of [5, 6, 7]) s.ingest(res(t, "down"));
  s.ingest(res(8, "up"));
  for (const t of [9, 10, 11]) s.ingest(res(t, "down"));
  const all = s.listIncidents();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((i) => i.id),
    [2, 1],
  ); // open first
  assert.equal(all[0]!.resolvedAt, null);
});

test("service: unknown check is rejected and stores nothing", () => {
  const s = createService(openDb(":memory:"));
  assert.throws(() => s.ingest(res(1, "up")), UnknownCheckError);
});

test("service: results newest first with limit", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const t of [1, 2, 3]) s.ingest(res(t, "up"));
  assert.deepEqual(
    s.listResults("c1", 2).map((r) => r.timestamp),
    [3, 2],
  );
});

test("service: state and counter persist across reopening a file DB", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pulse-db-")), "p.db");
  const db1 = openDb(path);
  const s1 = createService(db1);
  s1.upsertChecks([check]);
  s1.ingest(res(1, "down"));
  s1.ingest(res(2, "down"));
  db1.close();

  const db2 = openDb(path);
  const s2 = createService(db2);
  s2.upsertChecks([{ ...check, name: "Renamed" }]); // startup upsert keeps state
  const c = s2.listChecks()[0]!;
  assert.equal(c.name, "Renamed");
  assert.equal(c.state, "down");
  assert.equal(c.consecutiveDown, 2);
  assert.deepEqual(s2.listIncidents(), []);
  s2.ingest(res(3, "down")); // the 3rd down across the restart opens the incident
  assert.deepEqual(
    s2.listIncidents("open").map((i) => i.openedAt),
    [3],
  );
  assert.equal(s2.listResults("c1", 10).length, 3);
  db2.close();
});
