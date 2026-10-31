import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, type Result, validateLocationsResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import {
  createService,
  HEARTBEAT_LOCATION,
  MIN_LOCATION_SILENT_MS,
  NEWEST_PER_LOCATION_SQL,
} from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const CHECK: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 10_000 };

function up(t: number, location: string, checkId = "c1"): Result {
  return {
    checkId,
    timestamp: t,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
    location,
    attempts: 1,
  };
}

function setup(opts: { silentMs?: number; checks?: Check[] } = {}) {
  const clock = { t: 1_000_000 };
  const service = createService(openDb(":memory:"), {
    now: () => clock.t,
    ...(opts.silentMs === undefined ? {} : { locationSilentMs: opts.silentMs }),
  });
  service.upsertChecks(opts.checks ?? [CHECK]);
  return { clock, service };
}

test("locations: a result adds the location; the list is sorted by name", () => {
  const { service } = setup();
  assert.deepEqual(service.listLocations(), []);
  service.ingest(up(999_000, "west"));
  service.ingest(up(998_000, "east"));
  assert.deepEqual(service.listLocations(), [
    { name: "east", lastResultAt: 998_000, state: "reporting" },
    { name: "west", lastResultAt: 999_000, state: "reporting" },
  ]);
  assert.ok(validateLocationsResponse(service.listLocations()).ok);
});

test("locations: a late result never lowers lastResultAt", () => {
  const { service } = setup();
  service.ingest(up(5000, "east"));
  service.ingest(up(4000, "east"));
  assert.equal(service.listLocations()[0]?.lastResultAt, 5000);
});

test("locations: the heartbeat location is never listed", () => {
  const { service } = setup({
    checks: [CHECK, { id: "hb", name: "HB", type: "heartbeat", period: 1000, grace: 0 }],
  });
  service.ingest(up(5000, HEARTBEAT_LOCATION, "hb"));
  assert.deepEqual(service.listLocations(), []);
});

test("locations: silent after the threshold, by receive time not by result timestamp", () => {
  const { clock, service } = setup({ silentMs: 60_000 });
  service.ingest(up(1, "east")); // a replayed result with an old timestamp
  clock.t += 60_000;
  assert.equal(service.listLocations()[0]?.state, "reporting");
  clock.t += 1;
  assert.equal(service.listLocations()[0]?.state, "silent");
  service.ingest(up(2, "east"));
  assert.equal(service.listLocations()[0]?.state, "reporting");
  assert.equal(service.listLocations()[0]?.lastResultAt, 2);
});

test("locations: default threshold is 3 x the largest interval, at least 3 minutes", () => {
  const big: Check = { ...CHECK, id: "big", intervalMs: 120_000 };
  const { clock, service } = setup({ checks: [CHECK] });
  service.ingest(up(clock.t, "east"));
  clock.t += MIN_LOCATION_SILENT_MS;
  assert.equal(service.listLocations()[0]?.state, "reporting");
  clock.t += 1;
  assert.equal(service.listLocations()[0]?.state, "silent");
  // A reload with a slower check raises the threshold to 360 s, evaluated at read time.
  service.upsertChecks([CHECK, big]);
  assert.equal(service.listLocations()[0]?.state, "reporting");
  clock.t += 180_000;
  assert.equal(service.listLocations()[0]?.state, "silent");
});

test("locations: heartbeat checks do not raise the threshold; no checks gives the minimum", () => {
  const hb: Check = { id: "hb", name: "HB", type: "heartbeat", period: 3_600_000, grace: 0 };
  const { clock, service } = setup({ checks: [hb] });
  service.ingest(up(clock.t, "east", "hb"));
  service.ingest({ ...up(clock.t, "east", "hb"), location: "east" });
  clock.t += MIN_LOCATION_SILENT_MS + 1;
  assert.equal(service.listLocations()[0]?.state, "silent");
  service.upsertChecks([]);
  assert.equal(service.listLocations()[0]?.state, "silent");
});

test("locations: an explicit threshold overrides the derived one", () => {
  const { clock, service } = setup({ silentMs: 1000 });
  service.ingest(up(clock.t, "east"));
  clock.t += 1001;
  assert.equal(service.listLocations()[0]?.state, "silent");
});

test("locations: rebuilt at start from the stored results, without the heartbeat", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-loc-"));
  try {
    const path = join(dir, "t.db");
    const first = openDb(path);
    const s1 = createService(first, { now: () => 1000 });
    s1.upsertChecks([CHECK, { id: "hb", name: "HB", type: "heartbeat", period: 1000, grace: 0 }]);
    s1.ingest(up(500, "east"));
    s1.ingest(up(700, "east"));
    s1.ingest(up(600, "west"));
    s1.ingest(up(900, HEARTBEAT_LOCATION, "hb"));
    first.close();
    const clock = { t: 700 + MIN_LOCATION_SILENT_MS };
    const s2 = createService(openDb(path), { now: () => clock.t });
    // Seen counts from the newest stored result: east is still reporting, west just went silent.
    assert.deepEqual(s2.listLocations(), [
      { name: "east", lastResultAt: 700, state: "reporting" },
      { name: "west", lastResultAt: 600, state: "silent" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metric: last result per location in seconds, evaluated at scrape", () => {
  const { service } = setup();
  const metrics = createMetrics({ listLocations: () => service.listLocations() });
  assert.doesNotMatch(metrics.render(), /pulse_api_location_last_result_timestamp_seconds\{/);
  service.ingest(up(1_500_000, "east"));
  service.ingest(up(1_600_000, "west"));
  service.ingest(up(1_000, "east"));
  const text = metrics.render();
  assert.match(text, /pulse_api_location_last_result_timestamp_seconds\{location="east"\} 1500\n/);
  assert.match(text, /pulse_api_location_last_result_timestamp_seconds\{location="west"\} 1600\n/);
  assert.doesNotMatch(text, /location="heartbeat"/);
});

const OLD_NEWEST_PER_LOCATION_SQL =
  "SELECT location, MAX(timestamp) AS t FROM results WHERE location != ? GROUP BY location";

test("locations: the start query returns the rows of the old full scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-loc-"));
  try {
    const path = join(dir, "t.db");
    const first = openDb(path);
    const s1 = createService(first, { now: () => 1000 });
    const hb: Check = { id: "hb", name: "HB", type: "heartbeat", period: 1000, grace: 0 };
    const c2: Check = { ...CHECK, id: "c2" };
    const gone: Check = { ...CHECK, id: "gone" };
    s1.upsertChecks([CHECK, c2, gone, hb]);
    s1.ingest(up(500, "east"));
    s1.ingest(up(700, "east"));
    s1.ingest(up(650, "west"));
    s1.ingest(up(800, "east", "c2"));
    s1.ingest(up(300, "west", "c2"));
    s1.ingest(up(400, "north", "c2"));
    // Only an inactive check reports from "south", and its newest "west" result is the newest.
    s1.ingest(up(200, "south", "gone"));
    s1.ingest(up(900, "west", "gone"));
    s1.ingest(up(950, HEARTBEAT_LOCATION, "hb"));
    s1.ingest(up(960, "east", "hb"));
    s1.upsertChecks([CHECK, c2, hb]);
    first.close();

    const db = openDb(path);
    const old = db.prepare(OLD_NEWEST_PER_LOCATION_SQL).all(HEARTBEAT_LOCATION);
    const loose = db.prepare(NEWEST_PER_LOCATION_SQL).all(HEARTBEAT_LOCATION);
    const byName = (a: unknown, b: unknown): number =>
      String((a as { location: string }).location) < String((b as { location: string }).location)
        ? -1
        : 1;
    assert.deepEqual([...loose].sort(byName), [...old].sort(byName));
    assert.equal(old.length, 4);
    const s2 = createService(db, { now: () => 1000 });
    assert.deepEqual(
      s2.listLocations().map(({ name, lastResultAt }) => ({ name, lastResultAt })),
      [
        { name: "east", lastResultAt: 960 },
        { name: "north", lastResultAt: 400 },
        { name: "south", lastResultAt: 200 },
        { name: "west", lastResultAt: 900 },
      ],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locations: the start query seeks the sample index and never scans or sorts results", () => {
  const db = openDb(":memory:");
  const plan = (sql: string): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(HEARTBEAT_LOCATION) as { detail: string }[]).map(
      (r) => r.detail,
    );
  const details = plan(NEWEST_PER_LOCATION_SQL);
  const onResults = details.filter((d) => /\bresults\b/.test(d));
  assert.ok(onResults.length > 0);
  for (const d of onResults) {
    assert.match(d, /^SEARCH results USING COVERING INDEX results_by_sample \(check_id=\?/);
  }
  // The only sort groups the CTE rows, one per (check, location), right after their scan.
  const sorts = details.flatMap((d, i) => (d.startsWith("USE TEMP B-TREE") ? [i] : []));
  for (const i of sorts) assert.equal(details[i - 1], "SCAN locs");
  // The old query, for contrast: a full index scan of results and a sort of all its rows.
  assert.deepEqual(plan(OLD_NEWEST_PER_LOCATION_SQL), [
    "SCAN results USING COVERING INDEX results_by_sample",
    "USE TEMP B-TREE FOR GROUP BY",
  ]);
  db.close();
});
