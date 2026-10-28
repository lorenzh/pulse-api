import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { validateResult } from "./server.ts";
import { createService } from "./service.ts";
import { quorumStatus } from "./state.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };

function r(t: number, location: string, status: "up" | "down", reason?: string): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status,
    statusCode: status === "up" ? 200 : 503,
    latencyMs: 1,
    reason: status === "down" ? (reason ?? `${location}@${t}`) : null,
    location,
    attempts: 1,
  };
}

function setup() {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  return s;
}

test("quorumStatus: 1, 2 and 3 locations", () => {
  assert.equal(quorumStatus(["down"]), "down");
  assert.equal(quorumStatus(["up"]), "up");
  assert.equal(quorumStatus(["down", "up"]), "up");
  assert.equal(quorumStatus(["down", "down"]), "down");
  assert.equal(quorumStatus(["down", "up", "up"]), "up");
  assert.equal(quorumStatus(["down", "down", "up"]), "down");
});

test("quorum: one failing location never opens an incident", () => {
  const s = setup();
  for (let t = 1; t <= 10; t++) {
    s.ingest(r(t * 100, "b", "up"));
    s.ingest(r(t * 100 + 1, "c", "up"));
    s.ingest(r(t * 100 + 2, "a", "down"));
  }
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "up");
  assert.deepEqual(s.listIncidents(), []);
  assert.deepEqual(
    c.locations.map((l) => [l.location, l.result.status, l.stale]),
    [
      ["a", "down", false],
      ["b", "up", false],
      ["c", "up", false],
    ],
  );
});

test("quorum: two down open an incident on the 3rd evaluation, one recovering resolves", () => {
  const s = setup();
  s.ingest(r(1, "c", "up"));
  s.ingest(r(2, "a", "down", "ra1")); // a down, c up: up
  s.ingest(r(3, "b", "down", "rb1")); // 2 down: eval 1
  assert.equal(s.listChecks()[0]!.state, "down");
  assert.equal(s.listChecks()[0]!.consecutiveDown, 1);
  s.ingest(r(4, "a", "down", "ra2")); // eval 2
  assert.deepEqual(s.listIncidents(), []);
  s.ingest(r(5, "b", "down", "rb2")); // eval 3: opens
  assert.deepEqual(s.listIncidents("open"), [
    { id: 1, checkId: "c1", openedAt: 5, resolvedAt: null, reason: "rb2" },
  ]);
  const c = s.listChecks()[0]!;
  assert.equal(c.consecutiveDown, 3);
  assert.equal(c.lastResultAt, 5);
  assert.equal(c.lastReason, "rb2");
  s.ingest(r(6, "b", "up"));
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.equal(s.listChecks()[0]!.consecutiveDown, 0);
  assert.equal(s.listIncidents("resolved")[0]!.resolvedAt, 6);
});

test("quorum: a single location in the window decides alone", () => {
  const s = setup();
  s.ingest(r(1, "a", "down"));
  assert.equal(s.listChecks()[0]!.state, "down");
});

test("quorum: window expiry drops a location after 2 intervals", () => {
  const s = setup();
  s.ingest(r(1000, "a", "down"));
  s.ingest(r(1500, "b", "down")); // a and b down: down
  assert.equal(s.listChecks()[0]!.state, "down");
  // a's result at 1000 is outside [3500-2000, 3500]; only c remains, up decides alone.
  s.ingest(r(3500, "c", "up"));
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "up");
  assert.deepEqual(
    c.locations.map((l) => [l.location, l.stale]),
    [
      ["a", true],
      ["b", false], // exactly 2 intervals old is inside
      ["c", false],
    ],
  );
  // boundary: exactly 2 intervals old is still inside
  s.ingest(r(3500, "a", "down"));
  s.ingest(r(4500, "c", "down")); // window [2500, 4500]: a@3500 down, c@4500 down
  assert.equal(s.listChecks()[0]!.state, "down");
});

test("quorum: results newer than the ingested one are ignored", () => {
  const s = setup();
  s.ingest(r(100, "a", "up"));
  s.ingest(r(200, "b", "down"));
  s.ingest(r(300, "c", "down"));
  assert.equal(s.listChecks()[0]!.state, "down");
  // late result at t=150: window sees a up, only; b and c are newer
  s.ingest(r(150, "a", "up"));
  assert.equal(s.listChecks()[0]!.state, "up");
});

test("quorum: per-location latest uses the highest timestamp, ties by id", () => {
  const s = setup();
  s.ingest(r(10, "a", "down"));
  s.ingest(r(10, "a", "up")); // same timestamp, higher id: a is up
  s.ingest(r(11, "b", "down"));
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.equal(s.listChecks()[0]!.locations[0]!.result.status, "up");
});

test("quorum: location names are case-sensitive", () => {
  const s = setup();
  s.ingest(r(1, "A", "down"));
  s.ingest(r(2, "a", "down"));
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "down");
  assert.deepEqual(
    c.locations.map((l) => l.location),
    ["A", "a"],
  );
});

test("locations: empty without results; results listing carries location", () => {
  const s = setup();
  assert.deepEqual(s.listChecks()[0]!.locations, []);
  s.ingest(r(1, "eu", "up"));
  assert.equal(s.listResults("c1", 10)[0]!.location, "eu");
});

test("validateResult: location normalisation", () => {
  const base = { ...r(1, "x", "up") } as Record<string, unknown>;
  const loc = (v: unknown) => {
    const out = validateResult({ ...base, location: v });
    return typeof out === "string" ? out : out.location;
  };
  assert.equal(loc("  eu  "), "eu");
  assert.equal(loc(""), "default");
  assert.equal(loc("   "), "default");
  assert.equal(loc("x".repeat(64)), "x".repeat(64));
  assert.equal(loc(` ${"x".repeat(64)} `), "x".repeat(64));
  assert.match(String(loc("x".repeat(65))), /location/);
  assert.match(String(loc(5)), /location/);
  assert.match(String(loc(null)), /location/);
  // eslint-disable-next-line sonarjs/no-unused-vars -- rest destructuring omits a property to build the test input
  const { location: _l, ...noLoc } = base;
  assert.equal((validateResult(noLoc) as Result).location, "default");
});

test("migration: old database without location column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pulse-migrate-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, timeout_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_down INTEGER NOT NULL DEFAULT 0, last_result_at INTEGER, last_reason TEXT);
    CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, status TEXT NOT NULL, status_code INTEGER,
      latency_ms REAL NOT NULL, reason TEXT);
    INSERT INTO checks (id, name, url, interval_ms) VALUES ('c1', 'C1', 'http://x/', 1000);
    INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason)
      VALUES ('c1', 5, 'up', 200, 1, NULL);
  `);
  old.close();
  for (let i = 0; i < 2; i++) {
    const migrated = openDb(path);
    const s = createService(migrated);
    assert.equal(s.listResults("c1", 10)[0]!.location, "default");
    assert.deepEqual(
      s.listChecks()[0]!.locations.map((l) => l.location),
      ["default"],
    );
    migrated.close();
  }
});
