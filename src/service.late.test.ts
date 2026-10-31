import type { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
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
  s.ingest(r(400, "c", "up"));
  assert.equal(s.listChecks()[0]!.locations.find((l) => l.location === "c")?.result.status, "up");
  assert.notEqual(s.listChecks()[0]!.lastReason, "c@400");
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

// A late result for a closed day and the stored uptime tally of that day (`uptime_daily`).

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");
const TODAY_DAY = TODAY / DAY;

function dayRow(db: Database, id: string, day: number): unknown {
  return db
    .prepare("SELECT good, total FROM uptime_daily WHERE check_id = ? AND day = ?")
    .get(id, day);
}

function setupDays() {
  const db = openDb(":memory:");
  const s = createService(db, { now: () => NOW });
  s.upsertChecks([check, { id: "hb", name: "HB", type: "heartbeat", period: 60_000, grace: 0 }]);
  const restarted = () => createService(db, { now: () => NOW });
  return { db, s, restarted };
}

const at = (t: number, status: "up" | "down" | "degraded", location = "a"): Result => ({
  ...r(t, location, status === "degraded" ? "up" : status),
  status,
});

const ping = (t: number): Result => ({ ...r(t, "heartbeat", "up"), checkId: "hb" });

test("late result: a stored closed day is updated in the same write, down and degraded by their rule", () => {
  const { db, s, restarted } = setupDays();
  const d = TODAY - 2 * DAY;
  s.ingest(at(NOW - 1000, "up"));
  s.ingest(at(d + 1000, "up", "b"));
  s.ingest(at(d + 2000, "up", "b"));
  s.getUptime();
  assert.deepEqual(dayRow(db, "c1", TODAY_DAY - 2), { good: 2, total: 2 });
  s.ingest(at(d + 5000, "down")); // late: location a has NOW - 1000
  assert.deepEqual(dayRow(db, "c1", TODAY_DAY - 2), { good: 2, total: 3 });
  assert.equal(s.getUptime()[0]?.days[87]?.results, 3, "the read after the ingest shows it");
  s.ingest(at(d + 6000, "degraded"));
  assert.deepEqual(dayRow(db, "c1", TODAY_DAY - 2), { good: 3, total: 4 });
  assert.equal(s.getUptime()[0]?.days[87]?.uptime, 75);
  // A repeat of a stored sample changes nothing.
  assert.equal(s.ingest(at(d + 6000, "degraded")), false);
  assert.deepEqual(dayRow(db, "c1", TODAY_DAY - 2), { good: 3, total: 4 });
  // The row stands for the results: a restart that reads it gives the same day.
  db.run("DELETE FROM results WHERE timestamp < ?", [TODAY]);
  assert.equal(restarted().getUptime()[0]?.days[87]?.uptime, 75);
});

test("late result: a closed day without a row gets no row; it is counted when it is filled", () => {
  const { db, s } = setupDays();
  s.ingest(at(NOW - 1000, "up"));
  s.ingest(at(TODAY - 3 * DAY + 1000, "down"));
  assert.equal(dayRow(db, "c1", TODAY_DAY - 3), null);
  assert.equal(s.fillUptimeDay("c1", TODAY_DAY - 3), true);
  assert.deepEqual(dayRow(db, "c1", TODAY_DAY - 3), { good: 0, total: 1 });
});

test("late result: a generated sample moved across midnight updates the day it is stored in", () => {
  const { db, s } = setupDays();
  const lastMs = TODAY - 1; // the last ms of yesterday
  s.ingest(ping(lastMs), true);
  s.getUptime();
  assert.deepEqual(dayRow(db, "hb", TODAY_DAY - 1), { good: 1, total: 1 });
  // Collides with the stored sample: stored at TODAY, which has no row, so yesterday stays.
  assert.equal(s.ingest(ping(lastMs), true), true);
  assert.deepEqual(dayRow(db, "hb", TODAY_DAY - 1), { good: 1, total: 1 });
  assert.equal(s.getUptime()[1]?.days[88]?.results, 1);

  const other = setupDays();
  other.s.ingest(ping(TODAY - DAY + 1000), true);
  other.s.getUptime();
  assert.deepEqual(dayRow(other.db, "hb", TODAY_DAY - 1), { good: 1, total: 1 });
  // No collision: stored at the last ms of yesterday, so yesterday is updated.
  other.s.ingest(ping(lastMs), true);
  assert.deepEqual(dayRow(other.db, "hb", TODAY_DAY - 1), { good: 2, total: 2 });
  assert.equal(other.s.getUptime()[1]?.days[88]?.results, 2);
});
