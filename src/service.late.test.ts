import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };

function r(t: number, location: string, status: "up" | "down"): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status,
    statusCode: status === "up" ? 200 : 503,
    latencyMs: 1,
    reason: status === "down" ? `${location}@${t}` : null,
    location,
    attempts: 1,
  };
}

function setup() {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  return s;
}

function downWithIncident() {
  const s = setup();
  s.ingest(r(100, "a", "down"));
  s.ingest(r(200, "b", "down"));
  s.ingest(r(300, "a", "down"));
  s.ingest(r(400, "b", "down"));
  assert.equal(s.listIncidents("open").length, 1);
  return s;
}

test("late result: stored in history, live state and incident unchanged", () => {
  const s = downWithIncident();
  const before = s.listChecks()[0]!;
  s.ingest(r(150, "a", "up")); // a already has t=300
  const after = s.listChecks()[0]!;
  assert.equal(after.state, "down");
  assert.equal(after.consecutiveDown, before.consecutiveDown);
  assert.equal(after.lastResultAt, before.lastResultAt);
  assert.equal(after.lastReason, before.lastReason);
  assert.equal(s.listIncidents("open").length, 1);
  assert.equal(s.listResults("c1", 10).length, 5);
  assert.ok(s.listResults("c1", 10).some((x) => x.timestamp === 150 && x.status === "up"));
  // The late row is not the latest of its location.
  const loc = after.locations.find((l) => l.location === "a");
  assert.equal(loc?.result.timestamp, 300);
});

test("late result: an equal timestamp is not late", () => {
  const s = downWithIncident();
  s.ingest(r(400, "b", "up"));
  assert.equal(s.listChecks()[0]!.locations.find((l) => l.location === "b")?.result.status, "up");
  assert.notEqual(s.listChecks()[0]!.lastReason, "b@400");
});

test("late result: another location still takes part in quorum", () => {
  const s = downWithIncident();
  s.ingest(r(450, "c", "up")); // first result of c, newer than the rest: not late
  assert.equal(s.listChecks()[0]!.lastResultAt, 450);
});

test("a result older than another location's newest never changes state or incidents", () => {
  const s = setup();
  s.ingest(r(100, "a", "down"));
  s.ingest(r(200, "b", "down"));
  s.ingest(r(300, "a", "down")); // third down result: the incident opens at 300
  assert.equal(s.listIncidents("open")[0]?.openedAt, 300);
  // 250 is stored (b's own newest is 200) but older than a's 300: the incident stays open.
  s.ingest(r(250, "b", "up"));
  assert.deepEqual(s.listIncidents("resolved"), []);
  assert.equal(s.listIncidents("open").length, 1);
  assert.equal(s.listChecks()[0]!.lastResultAt, 300);
  assert.equal(s.listResults("c1", 10).length, 4);
});

test("late result: never enters a later window, so the incident stays open", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([{ ...check, intervalMs: 100 }]);
  s.ingest(r(100, "a", "down"));
  s.ingest(r(300, "a", "down"));
  s.ingest(r(400, "a", "down"));
  assert.equal(s.listIncidents("open").length, 1);
  s.ingest(r(150, "a", "up")); // late: a already has t=400
  s.ingest(r(200, "b", "down")); // window [0, 200] contains the late row
  assert.equal(s.listChecks()[0]!.state, "down");
  assert.equal(s.listIncidents("open").length, 1);
  assert.ok(s.listResults("c1", 10).some((x) => x.timestamp === 150 && x.status === "up"));
});

test("migration: late column is added and the backfill marks earlier-inserted older rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-migrate-late-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, timeout_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_down INTEGER NOT NULL DEFAULT 0, last_result_at INTEGER, last_reason TEXT);
    CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, status TEXT NOT NULL, status_code INTEGER,
      latency_ms REAL NOT NULL, reason TEXT, location TEXT NOT NULL DEFAULT 'default');
    INSERT INTO checks (id, name, url, interval_ms) VALUES ('c1', 'C1', 'http://x/', 1000);
    INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, location) VALUES
      ('c1', 300, 'down', 503, 1, 'a'),
      ('c1', 150, 'up', 200, 1, 'a'),
      ('c1', 100, 'up', 200, 1, 'b');
  `);
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  const rows = db.prepare("SELECT timestamp, late FROM results ORDER BY id").all();
  assert.deepEqual(
    rows.map((x) => [x.timestamp, x.late]),
    [
      [300, 0],
      [150, 1],
      [100, 0],
    ],
  );
  assert.equal(createService(db).listResults("c1", 10).length, 3);
});

test("two locations: loc2 at t=50 after loc1 at t=100 keeps last_result_at and state", () => {
  const s = setup();
  s.ingest(r(100, "loc1", "up"));
  s.ingest(r(50, "loc2", "down"));
  const c = s.listChecks()[0]!;
  assert.equal(c.lastResultAt, 100);
  assert.equal(c.state, "up");
  assert.equal(c.consecutiveDown, 0);
  assert.equal(s.listResults("c1", 10).length, 2);
});
