import type { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { UptimeDay } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");

function setup(now = () => NOW) {
  const db = openDb(":memory:");
  const service = createService(db, { now });
  service.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
    { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
    { id: "b", name: "B", url: "http://b/", intervalMs: 60_000 },
  ]);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES (?, ?, ?, 1, ?)",
  );
  const add = (t: number, status: string, n = 1, id = "a", loc = "default") => {
    db.run("BEGIN");
    for (let i = 0; i < n; i++) insert.run(id, t + i, status, loc);
    db.run("COMMIT");
  };
  return { db, service, add };
}

test("uptime: acceptance seed", () => {
  const { service, add } = setup();
  add(TODAY - 4 * DAY + 1000, "up", 50);
  add(TODAY - 3 * DAY + 1000, "up", 76);
  add(TODAY - 3 * DAY + 2000, "down", 24);
  add(TODAY - 1 * DAY + 1000, "up", 60);
  add(TODAY - 1 * DAY + 2000, "degraded", 10);
  add(TODAY + 1000, "up", 5);
  const [a, b] = service.getUptime();
  assert.equal(a!.checkId, "a");
  assert.equal(b!.checkId, "b");
  assert.equal(a!.days.length, 90);
  assert.equal(a!.days[89]!.date, "2026-10-28");
  assert.equal(a!.days[0]!.date, "2026-07-31");
  const at = (n: number) => a!.days[89 - n]!;
  assert.equal(at(4).uptime, 100);
  assert.equal(at(3).uptime, 76);
  assert.equal(at(3).results, 100);
  assert.equal(at(2).uptime, null);
  assert.equal(at(2).results, 0);
  assert.equal(at(1).uptime, 100);
  assert.equal(at(0).uptime, 100);
  assert.equal(a!.days[0]!.uptime, null);
  assert.equal(a!.uptime, ((50 + 76 + 70 + 5) / (50 + 100 + 70 + 5)) * 100);
});

test("uptime: check without results", () => {
  const { service } = setup();
  const b = service.getUptime()[1]!;
  assert.equal(b.days.length, 90);
  assert.ok(b.days.every((d) => d.uptime === null && d.results === 0));
  assert.equal(b.uptime, null);
});

test("uptime: window edges and ignored results", () => {
  const { service, add } = setup();
  const start = TODAY - 89 * DAY;
  add(start - 1, "down");
  add(start, "up");
  add(NOW, "down");
  add(NOW + 1, "down", 5);
  const a = service.getUptime()[0]!;
  assert.equal(a.days[0]!.results, 1);
  assert.equal(a.days[0]!.uptime, 100);
  assert.equal(a.days[89]!.results, 1);
  assert.equal(a.days[89]!.uptime, 0);
  assert.equal(a.uptime, 50);
});

test("uptime: last ms of a day belongs to that day; all locations count", () => {
  const { service, add } = setup();
  add(TODAY - 1, "up", 1, "a", "eu");
  add(TODAY - 1, "down", 1, "a", "us");
  add(TODAY, "degraded");
  const a = service.getUptime()[0]!;
  assert.equal(a.days[88]!.uptime, 50);
  assert.equal(a.days[88]!.results, 2);
  assert.equal(a.days[89]!.uptime, 100);
});

test("uptime: moving the clock one day shifts the window", () => {
  let t = NOW;
  const { service, add } = setup(() => t);
  add(TODAY - 89 * DAY, "up");
  assert.equal(service.getUptime()[0]!.days[0]!.results, 1);
  t = NOW + DAY;
  const a = service.getUptime()[0]!;
  assert.equal(a.days[89]!.date, "2026-10-29");
  assert.equal(a.days[0]!.date, "2026-08-01");
  assert.equal(a.uptime, null);
});

test("uptime: 130k rows aggregate quickly", () => {
  const { service, add, db } = setup();
  db.run("BEGIN");
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('a', ?, ?, 1)",
  );
  const first = TODAY - 89 * DAY;
  let up = 0;
  let all = 0;
  for (let t = first; t <= NOW; t += 60_000) {
    const status = all % 10 === 0 ? "down" : "up";
    if (status === "up") up++;
    all++;
    insert.run(t, status);
  }
  db.run("COMMIT");
  // eslint-disable-next-line sonarjs/void-use -- void marks the intentionally unused helper in this benchmark-style test
  void add;
  assert.ok(all > 125_000);
  const started = performance.now();
  const a = service.getUptime()[0]!;
  assert.ok(performance.now() - started < 1000);
  assert.equal(a.uptime, (up / all) * 100);
  assert.equal(
    a.days.reduce((n, d) => n + d.results, 0),
    all,
  );
});

test("uptime: GET /uptime serves JSON", async () => {
  const { service, add } = setup();
  add(TODAY + 1000, "up");
  const server = createApiServer(service, {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/uptime`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      checkId: string;
      uptime: number | null;
      days: unknown[];
    }[];
    assert.deepEqual(
      body.map((c) => c.checkId),
      ["a", "b"],
    );
    assert.equal(body[0]!.days.length, 90);
    assert.equal(body[0]!.uptime, 100);
    assert.equal(body[1]!.uptime, null);
    assert.equal((await fetch(`${base}/uptime`, { method: "POST" })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// The stored closed-day tallies in `uptime_daily`.

const TODAY_DAY = TODAY / DAY;

interface FixtureRow {
  t: number;
  status: string;
  loc: string;
}

/** 90 days and today with mixed statuses, two locations, empty days and rows marked late. */
function fixtureRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  const statuses = ["up", "up", "degraded", "down", "up"];
  for (let back = 92; back >= 0; back--) {
    if (back % 7 === 3) continue; // an empty day
    const start = TODAY - back * DAY;
    const n = (back % 5) + 1;
    for (let i = 0; i < n; i++) {
      const loc = i % 2 === 0 ? "eu" : "us";
      rows.push({ t: start + i * 3_600_000, status: statuses[(back + i) % 5] ?? "up", loc });
    }
    // The first and the last ms of the day.
    rows.push({ t: start, status: back % 3 === 0 ? "down" : "up", loc: "edge" });
    rows.push({ t: start + DAY - 1, status: "up", loc: "edge" });
  }
  return rows.filter((r) => r.t <= NOW + 5000);
}

function seedFixture(db: Database, rows: FixtureRow[]): void {
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location, late) VALUES ('a', ?, ?, 1, ?, ?)",
  );
  db.run("BEGIN");
  for (const [i, r] of rows.entries()) insert.run(r.t, r.status, r.loc, i % 4 === 0 ? 1 : 0);
  db.run("COMMIT");
}

/** The expected days and window uptime, recomputed with a plain loop over the fixture rows. */
function expectedUptime(rows: FixtureRow[], windowDays: number) {
  const days: UptimeDay[] = [];
  let good = 0;
  let total = 0;
  for (let d = TODAY_DAY - (windowDays - 1); d <= TODAY_DAY; d++) {
    const inDay = rows.filter((r) => Math.floor(r.t / DAY) === d && r.t <= NOW);
    const g = inDay.filter((r) => r.status !== "down").length;
    good += g;
    total += inDay.length;
    days.push({
      date: new Date(d * DAY).toISOString().slice(0, 10),
      uptime: inDay.length === 0 ? null : (g / inDay.length) * 100,
      results: inDay.length,
    });
  }
  return { days, uptime: total === 0 ? null : (good / total) * 100 };
}

const storedDays = (db: Database, id = "a"): number =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM uptime_daily WHERE check_id = ?").get(id) as {
      n: number;
    }
  ).n;

test("uptime table: answers with no rows, some rows and all rows equal a recomputation", () => {
  const rows = fixtureRows();
  const expected90 = expectedUptime(rows, 90);
  const expected30 = expectedUptime(rows, 30).days;
  const { db } = setup();
  seedFixture(db, rows);
  const fresh = () => createService(db, { now: () => NOW });

  assert.equal(storedDays(db), 0);
  const none = fresh();
  assert.deepEqual(none.getUptime()[0], { checkId: "a", ...expected90 });
  assert.deepEqual(none.getSloDays("a"), expected30);
  assert.equal(storedDays(db), 89);

  db.run("DELETE FROM uptime_daily WHERE day % 2 = 0");
  const partial = fresh();
  assert.deepEqual(partial.getSloDays("a"), expected30);
  assert.deepEqual(partial.getUptime()[0], { checkId: "a", ...expected90 });

  const all = fresh();
  assert.equal(storedDays(db), 89);
  assert.deepEqual(all.getUptime()[0], { checkId: "a", ...expected90 });
  assert.deepEqual(all.getSloDays("a"), expected30);
  // A day without results is stored as 0 of 0, and no row exists for today.
  const empty = db
    .prepare("SELECT good, total FROM uptime_daily WHERE check_id = 'a' AND day = ?")
    .get(TODAY_DAY - 3);
  assert.deepEqual(empty, { good: 0, total: 0 });
  const today = db
    .prepare("SELECT COUNT(*) AS n FROM uptime_daily WHERE day >= ?")
    .get(TODAY_DAY) as { n: number };
  assert.equal(today.n, 0);
});

test("uptime table: the tally of a day counts every location, degraded as good", () => {
  const { db, service, add } = setup();
  const d = TODAY - 2 * DAY;
  add(d + 1000, "up", 1, "a", "east");
  add(d + 2000, "degraded", 1, "a", "east");
  add(d + 3000, "down", 1, "a", "east");
  add(d + 4000, "up", 1, "a", "west");
  assert.equal(service.getUptime()[0]?.days[87]?.uptime, 75);
  const row = db
    .prepare("SELECT good, total FROM uptime_daily WHERE check_id = 'a' AND day = ?")
    .get(TODAY_DAY - 2);
  assert.deepEqual(row, { good: 3, total: 4 });
});

test("uptime table: a restart reads the closed days from the table, not from the results", () => {
  const { db, service, add } = setup();
  add(TODAY - 2 * DAY + 1000, "up", 3);
  add(TODAY - 2 * DAY + 5000, "down", 1);
  add(TODAY - 40 * DAY, "up", 2);
  add(TODAY + 1000, "up", 1);
  const before = service.getUptime();
  db.run("DELETE FROM results WHERE timestamp < ?", [TODAY]);
  const restarted = createService(db, { now: () => NOW });
  assert.deepEqual(restarted.getUptime(), before);
  assert.equal(before[0]?.days[87]?.uptime, 75);
  assert.equal(before[0]?.days[49]?.results, 2);
});

test("uptime table: a closed day gets its row at the first read after midnight, a future result counts once", () => {
  let t = TODAY + DAY - 30_000; // 23:59:30
  const { db, service } = setup(() => t);
  const result = (timestamp: number) => ({
    checkId: "a",
    timestamp,
    status: "down" as const,
    statusCode: 500,
    latencyMs: 1,
    reason: "x",
    location: "default",
    attempts: 1,
  });
  service.ingest(result(TODAY + 1000));
  // 60 s skew: stamped 00:00:20 of the next day.
  service.ingest(result(TODAY + DAY + 20_000));
  const before = service.getUptime()[0];
  assert.equal(before?.days[89]?.results, 1, "a result after now does not count today");
  assert.equal(storedDays(db), 89);
  t = TODAY + DAY + 30_000;
  const after = service.getUptime()[0];
  assert.equal(storedDays(db), 90, "yesterday is stored at the first read after midnight");
  assert.equal(after?.days[88]?.results, 1);
  assert.equal(after?.days[89]?.results, 1, "the skewed result counts in the new today");
  t = TODAY + 2 * DAY + 30_000;
  const later = service.getUptime()[0];
  assert.equal(later?.days[88]?.results, 1, "and once in its stored day");
  assert.equal(later?.uptime, 0);
  assert.equal(
    later?.days.reduce((n, d) => n + d.results, 0),
    2,
  );
});

test("uptime table: missing days are the closed days of the window; today and later are refused", () => {
  const { db, service, add } = setup();
  add(TODAY - DAY + 1000, "up", 2);
  add(TODAY - DAY + 2000, "down", 1);
  add(TODAY + 1000, "up", 1);
  const missing = service.missingUptimeDays("a");
  assert.equal(missing.length, 89);
  assert.equal(missing[0], TODAY_DAY - 89);
  assert.equal(missing.at(-1), TODAY_DAY - 1);
  assert.deepEqual(
    missing,
    [...missing].sort((x, y) => x - y),
  );
  assert.equal(service.fillUptimeDay("a", TODAY_DAY), false);
  assert.equal(service.fillUptimeDay("a", TODAY_DAY + 1), false);
  assert.equal(storedDays(db), 0);
  assert.equal(service.fillUptimeDay("a", TODAY_DAY - 1), true);
  assert.equal(service.fillUptimeDay("a", TODAY_DAY - 1), false);
  const row = db
    .prepare("SELECT good, total FROM uptime_daily WHERE check_id = 'a' AND day = ?")
    .get(TODAY_DAY - 1);
  assert.deepEqual(row, { good: 2, total: 3 });
  assert.equal(service.missingUptimeDays("a").length, 88);
  assert.ok(!service.missingUptimeDays("a").includes(TODAY_DAY - 1));
  assert.deepEqual(service.listUptimeCheckIds(), ["a", "b"]);
});
