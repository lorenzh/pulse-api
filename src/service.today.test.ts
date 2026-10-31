import type { Database } from "bun:sqlite";
import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, CheckStatus, Result, UptimeDay } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService, DAY_MS, type Service } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 10_000 };
/** 2026-10-31 12:00:00 UTC. */
const NOON = Date.UTC(2026, 9, 31, 12, 0, 0);
const TODAY = Math.floor(NOON / DAY_MS);

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function result(
  timestamp: number,
  location: string,
  status: CheckStatus,
  latencyMs: number,
): Result {
  return {
    checkId: "c1",
    timestamp,
    status,
    statusCode: status === "down" ? 503 : 200,
    latencyMs,
    reason: status === "up" ? null : `${status}@${timestamp}`,
    location,
    attempts: 1,
  };
}

/** A service on a file in its own temp directory, with a clock the test moves. */
function setup(start = NOON) {
  const dir = mkdtempSync(join(tmpdir(), "pulse-today-"));
  dirs.push(dir);
  const path = join(dir, "pulse.db");
  const clock = { t: start };
  const open = (): { db: Database; s: Service } => {
    const db = openDb(path);
    dbs.push(db);
    return { db, s: createService(db, { now: () => clock.t }) };
  };
  const { db, s } = open();
  s.upsertChecks([check]);
  return { db, s, clock, open };
}

function lastDay(s: Service): UptimeDay {
  const day = s.getUptime()[0]?.days.at(-1);
  assert.ok(day);
  return day;
}

function todayCount(s: Service): number | undefined {
  return s.getLatency()[0]?.days.at(-1)?.count;
}

/** Every read whose answer depends on today's state, as JSON. */
function reads(s: Service): string {
  return JSON.stringify({
    checks: s.listChecks(),
    uptime: s.getUptime(),
    slo: s.getSloDays("c1"),
    latency: s.getLatency(),
    check: s.getCheckLatency("c1"),
  });
}

test("today: incremental state equals a fresh build from the results after a mixed sequence", () => {
  const { s, open } = setup();
  s.ingest(result(NOON - 100_000, "a", "up", 5));
  // Build both records before the sequence, so it runs through the updates.
  assert.equal(lastDay(s).results, 1);
  assert.equal(todayCount(s), 1);
  assert.equal(s.ingest(result(NOON - 50_000, "a", "up", 10)), true);
  assert.equal(s.ingest(result(NOON - 40_000, "b", "degraded", 20)), true);
  assert.equal(s.ingest(result(NOON - 30_000, "a", "down", 9999)), true);
  // Late: b holds NOON - 40000 already.
  assert.equal(s.ingest(result(NOON - 60_000, "b", "up", 30)), true);
  // A repeat is stored once.
  assert.equal(s.ingest(result(NOON - 50_000, "a", "up", 10)), false);
  // A generated sample on an occupied timestamp moves by 1 ms.
  assert.equal(s.ingest(result(NOON - 30_000, "a", "up", 40), true), true);
  assert.equal(s.ingest(result(NOON + 30_000, "b", "up", 50)), true);

  const day = lastDay(s);
  // 6 rows up to now (the future row is left out), 1 of them down.
  assert.equal(day.results, 6);
  assert.equal(day.uptime, (5 / 6) * 100);
  // Latency covers the whole day: 6 non-down values, [5, 10, 20, 30, 40, 50].
  assert.deepEqual(s.getLatency()[0]?.days.at(-1), {
    date: "2026-10-31",
    p50Ms: 20,
    p95Ms: 50,
    count: 6,
  });
  assert.equal(reads(s), reads(open().s));
});

test("today: a future row counts in latency at once and in uptime when the clock reaches it", () => {
  const { s, clock } = setup();
  s.ingest(result(NOON - 1000, "a", "up", 5));
  assert.equal(lastDay(s).results, 1);
  assert.equal(todayCount(s), 1);
  s.ingest(result(NOON + 30_000, "a", "up", 6));
  assert.equal(lastDay(s).results, 1);
  assert.equal(todayCount(s), 2);
  clock.t = NOON + 30_000;
  assert.equal(lastDay(s).results, 2);
  assert.equal(todayCount(s), 2);
});

test("today: a rolled-back ingest changes neither uptime nor latency", () => {
  const { db, s } = setup();
  s.ingest(result(NOON - 2000, "a", "up", 5));
  const uptime = JSON.stringify(s.getUptime());
  const latency = JSON.stringify(s.getLatency());
  db.run("CREATE TRIGGER fail_state BEFORE UPDATE ON checks BEGIN SELECT RAISE(ABORT, 'x'); END");
  assert.throws(() => s.ingest(result(NOON - 1000, "a", "up", 7)));
  db.run("DROP TRIGGER fail_state");
  assert.equal(JSON.stringify(s.getUptime()), uptime);
  assert.equal(JSON.stringify(s.getLatency()), latency);
  assert.equal(lastDay(s).results, 1);
});

test("today: a result of the next day starts the new day after midnight", () => {
  const midnight = (TODAY + 1) * DAY_MS;
  const { s, clock, open } = setup(midnight - 30_000);
  s.ingest(result(midnight - 60_000, "a", "up", 5));
  s.ingest(result(midnight - 50_000, "a", "down", 9999));
  assert.equal(lastDay(s).results, 2);
  assert.equal(todayCount(s), 1);
  // 00:00:10 of the next day, accepted with the clock skew.
  s.ingest(result(midnight + 10_000, "a", "up", 8));
  clock.t = midnight - 20_000;
  assert.equal(lastDay(s).results, 2);
  assert.equal(todayCount(s), 1);
  clock.t = midnight + 60_000;
  const day = lastDay(s);
  assert.equal(day.date, "2026-11-01");
  assert.equal(day.results, 1);
  assert.deepEqual(s.getLatency()[0]?.days.at(-1), {
    date: "2026-11-01",
    p50Ms: 8,
    p95Ms: 8,
    count: 1,
  });
  const yesterday = s.getUptime()[0]?.days.at(-2);
  assert.deepEqual(yesterday, { date: "2026-10-31", uptime: 50, results: 2 });
  assert.equal(reads(s), reads(open().s));
});

test("today: a new service on the same file answers like the old one", () => {
  const { s, clock, open } = setup();
  s.ingest(result(NOON - 3000, "a", "up", 5));
  reads(s);
  s.ingest(result(NOON - 2000, "b", "degraded", 15));
  s.ingest(result(NOON - 1000, "a", "down", 9999));
  clock.t = NOON + 10_000;
  const before = reads(s);
  assert.equal(open().s.getUptime()[0]?.days.at(-1)?.results, 3);
  assert.equal(reads(open().s), before);
});

test("today: a read after an ingest does not re-read today's results", () => {
  const { db, s } = setup();
  s.ingest(result(NOON - 3000, "a", "up", 5));
  s.ingest(result(NOON - 2000, "b", "up", 6));
  assert.equal(lastDay(s).results, 2);
  assert.equal(todayCount(s), 2);
  s.ingest(result(NOON - 1000, "a", "up", 7));
  db.run("DELETE FROM results WHERE check_id = ? AND timestamp <= ?", ["c1", NOON]);
  assert.equal(lastDay(s).results, 3);
  assert.equal(todayCount(s), 3);
});

test("today: uptime reads and ingests never build the latency record", () => {
  const { db, s } = setup();
  s.ingest(result(NOON - 2000, "a", "up", 5));
  s.getUptime();
  s.listChecks();
  s.ingest(result(NOON - 1000, "a", "up", 6));
  db.run("DELETE FROM results WHERE check_id = ? AND timestamp <= ?", ["c1", NOON]);
  // The first latency read builds now, from the emptied table.
  assert.equal(todayCount(s), 0);
  // The uptime record was built before the delete and kept counting.
  assert.equal(lastDay(s).results, 2);
});

test("today: re-adding a removed check keeps its rows counted once", () => {
  const { s } = setup();
  s.ingest(result(NOON - 2000, "a", "up", 5));
  assert.equal(lastDay(s).results, 1);
  s.upsertChecks([]);
  s.upsertChecks([check]);
  s.ingest(result(NOON - 1000, "a", "up", 6));
  assert.equal(lastDay(s).results, 2);
  assert.equal(todayCount(s), 2);
});
