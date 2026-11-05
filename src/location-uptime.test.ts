import type { Database } from "bun:sqlite";
import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckLocationUptime, Result } from "@lorenzh/pulse-contract";
import { validateCheckLocationUptime } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService, type Service } from "./service.ts";
import { fillAllUptimeDays } from "./uptime-rollup.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const TODAY = Date.parse("2026-11-05T00:00:00Z");
/** The first instant of the window: (today - 89) * DAY_MS. */
const FIRST = Date.parse("2026-08-08T00:00:00.000Z");
/** A closed day inside the window. */
const CLOSED = Date.parse("2026-11-01T00:00:00Z");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-location-uptime-"));
  const db = openDb(join(dir, "t.db"));
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { t: NOW };
  const service = createService(db, { now: () => clock.t });
  service.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
    { id: "hb", name: "HB", type: "heartbeat", period: 60_000, grace: 1000 },
  ]);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES (?, ?, ?, 1, ?)",
  );
  const add = (t: number, status: string, loc: string, n = 1, id = "a"): void => {
    for (let i = 0; i < n; i++) insert.run(id, t + i, status, loc);
  };
  return { db, service, clock, add };
}

function read(service: Service, id = "a"): CheckLocationUptime {
  const value = service.getCheckLocationUptime(id);
  assert.ok(value !== undefined);
  assert.ok(validateCheckLocationUptime(value).ok, "typed by the contract");
  return value;
}

const counts = (v: CheckLocationUptime): [string, number, number, number | null][] =>
  v.locations.map((l) => [l.location, l.good, l.results, l.uptime]);

/** Sum of results per day of the aggregate /uptime of a check. */
function aggregateResults(service: Service, id = "a"): number {
  const uptime = service.getUptime().find((u) => u.checkId === id);
  return (uptime?.days ?? []).reduce((n, d) => n + d.results, 0);
}

const locationRows = (db: Database, day: number): unknown[] =>
  db
    .query(
      "SELECT location, good, total FROM uptime_location_daily WHERE check_id = 'a' AND day = ? ORDER BY location",
    )
    .all(day / DAY);

test("window: (today - 89) * DAY_MS counts, a millisecond before and after now do not", () => {
  const { service, add } = setup();
  add(FIRST, "up", "eu");
  add(Date.parse("2026-08-07T23:59:59.999Z"), "up", "eu");
  add(Date.parse("2026-08-07T12:00:00Z"), "up", "eu");
  add(NOW, "down", "eu");
  add(Date.parse("2026-11-05T12:00:00.001Z"), "up", "eu");
  assert.deepEqual(counts(read(service)), [["eu", 1, 2, 50]]);
  assert.equal(aggregateResults(service), 2);
});

test("more than 100 rows at two locations are counted over the whole window", () => {
  const { service, add } = setup();
  for (let d = 0; d < 60; d++) {
    add(FIRST + d * DAY + 1000, "up", "eu");
    add(FIRST + d * DAY + 2000, d % 6 === 0 ? "degraded" : "up", "eu");
    add(FIRST + d * DAY + 3000, d % 3 === 0 ? "down" : "up", "us");
  }
  add(TODAY + 1000, "down", "eu", 5);
  add(TODAY + 1000, "up", "us", 5);
  const v = read(service);
  assert.equal(v.checkId, "a");
  assert.equal(v.windowDays, 90);
  assert.deepEqual(counts(v), [
    ["eu", 120, 125, 96],
    ["us", 45, 65, (45 / 65) * 100],
  ]);
  assert.equal(service.listResults("a", 100).length, 100, "more rows than one results page");
  assert.equal(
    v.locations.reduce((n, l) => n + l.results, 0),
    aggregateResults(service),
  );
  assert.equal(aggregateResults(service), 190);
});

test("statistic: degraded is good, an old-only location is listed with null, all down is 0", () => {
  const { service, add } = setup();
  add(CLOSED + 1000, "up", "eu", 2);
  add(TODAY + 1000, "up", "eu");
  add(TODAY + 2000, "degraded", "eu");
  add(TODAY + 3000, "down", "eu");
  add(FIRST - 10 * DAY, "up", "us", 3);
  add(CLOSED, "down", "zz", 4);
  assert.deepEqual(counts(read(service)), [
    ["eu", 4, 5, 80],
    ["us", 0, 0, null],
    ["zz", 0, 4, 0],
  ]);
  assert.equal(aggregateResults(service), 9);
});

test("locations are unique and sorted by UTF-16 code units", () => {
  const { service, add } = setup();
  for (const loc of ["b", "B", "a"]) {
    add(CLOSED, "up", loc);
    add(TODAY, "up", loc);
  }
  assert.deepEqual(
    read(service).locations.map((l) => l.location),
    ["B", "a", "b"],
  );
});

test("a heartbeat check lists the heartbeat location; unknown and inactive ids are undefined", () => {
  const { service, add } = setup();
  add(CLOSED, "up", "heartbeat", 2, "hb");
  add(TODAY, "down", "heartbeat", 1, "hb");
  assert.deepEqual(counts(read(service, "hb")), [["heartbeat", 2, 3, (2 / 3) * 100]]);
  assert.equal(aggregateResults(service, "hb"), 3);
  assert.equal(service.getCheckLocationUptime("nope"), undefined);
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
  service.upsertChecks([{ id: "a", name: "A", url: "http://a/", intervalMs: 60_000 }]);
  assert.equal(service.getCheckLocationUptime("hb"), undefined);
});

test("complete-day rule: a day of 9 against 10 is rebuilt, a day of 10 is not read from results", () => {
  const { db, service, clock, add } = setup();
  add(CLOSED + 1000, "up", "eu", 6);
  add(CLOSED + 2000, "down", "us", 3);
  assert.deepEqual(counts(read(service)), [
    ["eu", 6, 6, 100],
    ["us", 0, 3, 0],
  ]);
  // A late result stored by an older release: uptime_daily says 10, the locations sum to 9.
  add(CLOSED + 9000, "down", "us");
  db.run("UPDATE uptime_daily SET total = total + 1 WHERE check_id = 'a' AND day = ?", [
    CLOSED / DAY,
  ]);
  assert.deepEqual(service.incompleteLocationDays("a"), [CLOSED / DAY]);
  clock.t += 5000;
  assert.deepEqual(counts(read(service)), [
    ["eu", 6, 6, 100],
    ["us", 0, 4, 0],
  ]);
  assert.deepEqual(locationRows(db, CLOSED), [
    { location: "eu", good: 6, total: 6 },
    { location: "us", good: 0, total: 4 },
  ]);
  assert.deepEqual(service.incompleteLocationDays("a"), []);
  // A complete day of 10 is taken as stored: a raw row added below it is not read.
  add(CLOSED + 20_000, "up", "eu");
  clock.t += 5000;
  assert.deepEqual(counts(read(service)), [
    ["eu", 6, 6, 100],
    ["us", 0, 4, 0],
  ]);
});

test("location rows deleted by hand are rebuilt on the next read", () => {
  const { db, service, clock, add } = setup();
  add(CLOSED + 1000, "up", "eu", 3);
  add(CLOSED + 1000, "degraded", "us", 2);
  const before = counts(read(service));
  db.run("DELETE FROM uptime_location_daily");
  clock.t += 5000;
  assert.deepEqual(counts(read(service)), before);
  assert.deepEqual(locationRows(db, CLOSED), [
    { location: "eu", good: 3, total: 3 },
    { location: "us", good: 2, total: 2 },
  ]);
});

function result(t: number, location: string, status: Result["status"]): Result {
  return {
    checkId: "a",
    timestamp: t,
    status,
    statusCode: status === "down" ? 503 : 200,
    latencyMs: 1,
    reason: status === "down" ? "boom" : null,
    location,
    attempts: 1,
  };
}

test("a late result for a filled closed day updates the next read exactly once", () => {
  const { db, service, add } = setup();
  add(CLOSED + 1000, "up", "eu", 2);
  assert.deepEqual(counts(read(service)), [["eu", 2, 2, 100]]);
  service.ingest(result(CLOSED + 5000, "eu", "down"));
  service.ingest(result(CLOSED + 6000, "us", "up"));
  assert.deepEqual(locationRows(db, CLOSED), [
    { location: "eu", good: 2, total: 3 },
    { location: "us", good: 1, total: 1 },
  ]);
  assert.deepEqual(counts(read(service)), [
    ["eu", 2, 3, (2 / 3) * 100],
    ["us", 1, 1, 100],
  ]);
  assert.deepEqual(service.incompleteLocationDays("a"), []);
});

test("an ingest for today or an unfilled closed day writes no location row", () => {
  const { db, service } = setup();
  service.ingest(result(CLOSED + 5000, "eu", "up"));
  service.ingest(result(TODAY + 5000, "eu", "up"));
  assert.deepEqual(db.query("SELECT * FROM uptime_location_daily").all(), []);
  assert.deepEqual(counts(read(service)), [["eu", 2, 2, 100]]);
  assert.deepEqual(locationRows(db, TODAY), []);
});

test("backfill: location days after the uptime days, a yield after each, stops when asked", async () => {
  const { db, service, add } = setup();
  add(CLOSED + 1000, "up", "eu", 2);
  add(CLOSED - DAY + 1000, "down", "us", 3);
  add(CLOSED - 2 * DAY + 1000, "up", "us", 1);
  let sleeps = 0;
  let isStopped = false;
  const first = await fillAllUptimeDays(
    {
      service,
      sleep: () => {
        sleeps++;
        // Stop after the first location day: every uptime day of both checks is done by then.
        if (sleeps === 2 * 89 + 1) isStopped = true;
        return Promise.resolve();
      },
    },
    () => isStopped,
  );
  assert.deepEqual(first, { checks: 2, written: 2 * 89, locationDays: 1 });
  assert.equal(sleeps, 2 * 89 + 1);
  assert.equal(service.incompleteLocationDays("a").length, 2);
  const second = await fillAllUptimeDays({ service, sleep: () => Promise.resolve() });
  assert.deepEqual(second, { checks: 2, written: 0, locationDays: 2 });
  assert.deepEqual(service.incompleteLocationDays("a"), []);
  assert.deepEqual(locationRows(db, CLOSED), [{ location: "eu", good: 2, total: 2 }]);
  assert.equal(service.fillLocationDay("a", CLOSED / DAY), false, "a complete day is skipped");
  assert.equal(service.fillLocationDay("a", TODAY / DAY), false, "today is never stored");
});

test("a read of an ordinary check reads the stored location window once", () => {
  const { db, add } = setup();
  add(CLOSED + 1000, "up", "eu");
  let reads = 0;
  // A hand-written fake: counts the range reads of the stored location rows.
  const counting = new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!/SELECT day, location, good, total FROM uptime_location_daily/.test(sql)) return stmt;
        return new Proxy(stmt, {
          get(s, k) {
            const value: unknown = Reflect.get(s, k, s);
            if (k !== "all" || typeof value !== "function") {
              return typeof value === "function" ? value.bind(s) : value;
            }
            return (...args: unknown[]) => {
              reads++;
              return Reflect.apply(value, s, args);
            };
          },
        });
      };
    },
  });
  const service = createService(counting, { now: () => NOW });
  read(service);
  assert.equal(reads, 1);
});
