import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  type CheckLatency,
  type ChecksResponse,
  validateCheckLatency,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { nearestRank } from "./latency.ts";
import { fillAllRollups, type LatencyRollupDeps, startLatencyRollup } from "./latency-rollup.ts";
import { cleanupResults } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService, type ServiceOptions } from "./service.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");

function setup(now: () => number = () => NOW, options: ServiceOptions = {}) {
  const db = openDb(":memory:");
  const service = createService(db, { ...options, now });
  service.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    { id: "b", name: "B", url: "http://b/", intervalMs: 60_000 },
    { id: "hb", name: "HB", type: "heartbeat", period: 60_000, grace: 1000 },
    { id: "tls", name: "TLS", type: "tls", host: "x", port: 443, warnDays: 7, intervalMs: 60_000 },
  ]);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES (?, ?, ?, ?, ?)",
  );
  const add = (t: number, latencies: number[], status = "up", id = "a", loc = "default") => {
    for (const [i, l] of latencies.entries()) insert.run(id, t + i, status, l, loc);
  };
  return { db, service, add };
}

const day = (l: CheckLatency, back: number) => l.days[89 - back];

test("nearest rank: n=1, n=2, n=4 and n=20", () => {
  assert.equal(nearestRank([], 50), null);
  assert.equal(nearestRank([7], 50), 7);
  assert.equal(nearestRank([7], 95), 7);
  assert.equal(nearestRank([10, 20], 50), 10);
  assert.equal(nearestRank([10, 20], 95), 20);
  assert.equal(nearestRank([10, 20, 30, 40], 50), 20);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(nearestRank(twenty, 95), 19);
  assert.equal(nearestRank(twenty, 50), 10);
});

test("latency: 90 days, today last, percentiles per UTC day", () => {
  const { service, add } = setup();
  add(TODAY - 2 * DAY + 1000, [40, 10, 30, 20]);
  add(TODAY + 1000, [5]);
  const [a] = service.getLatency();
  assert.ok(a);
  assert.equal(a.checkId, "a");
  assert.equal(a.days.length, 90);
  assert.equal(a.days[0]?.date, "2026-07-31");
  assert.equal(a.days[89]?.date, "2026-10-28");
  assert.deepEqual(day(a, 2), { date: "2026-10-26", p50Ms: 20, p95Ms: 40, count: 4 });
  assert.deepEqual(day(a, 1), { date: "2026-10-27", p50Ms: null, p95Ms: null, count: 0 });
  assert.deepEqual(day(a, 0), { date: "2026-10-28", p50Ms: 5, p95Ms: 5, count: 1 });
  assert.equal(validateCheckLatency(a).ok, true);
});

test("latency: down results are excluded, degraded and late results count, locations merge", () => {
  const { service, add } = setup();
  const t = TODAY - DAY + 1000;
  add(t, [10, 20], "up", "a", "eu");
  add(t + 100, [30], "degraded", "a", "us");
  add(t + 200, [9999, 9999], "down", "a", "eu");
  service.ingest({
    checkId: "a",
    timestamp: t - 500,
    status: "up",
    statusCode: 200,
    latencyMs: 40,
    reason: null,
    location: "eu",
    attempts: 1,
  });
  const [a] = service.getLatency();
  assert.deepEqual(day(a as CheckLatency, 1), {
    date: "2026-10-27",
    p50Ms: 20,
    p95Ms: 40,
    count: 4,
  });
});

test("latency: only active HTTP checks, in listChecks order; others answer as unknown", () => {
  const { service } = setup();
  assert.deepEqual(
    service.getLatency().map((l) => l.checkId),
    ["a", "b"],
  );
  assert.equal(service.getCheckLatency("hb"), undefined);
  assert.equal(service.getCheckLatency("tls"), undefined);
  assert.equal(service.getCheckLatency("nope"), undefined);
  assert.equal(service.getCheckLatency("b")?.checkId, "b");
});

test("latency: a closed day is stored once and equals the live computation", () => {
  const { db, service, add } = setup();
  add(TODAY - 3 * DAY + 1000, [3, 1, 2]);
  const live = service.getCheckLatency("a");
  const row = db
    .query("SELECT * FROM latency_daily WHERE check_id = 'a' AND day = ?")
    .get((TODAY - 3 * DAY) / DAY);
  assert.deepEqual(row, {
    check_id: "a",
    day: (TODAY - 3 * DAY) / DAY,
    p50_ms: 2,
    p95_ms: 3,
    count: 3,
  });
  // Empty closed days get a count 0 row, so they are not scanned again; today is never stored.
  const stored = db.query("SELECT COUNT(*) AS n FROM latency_daily WHERE check_id = 'a'").get();
  assert.deepEqual(stored, { n: 89 });
  // A late result for a closed day does not change its rollup.
  add(TODAY - 3 * DAY + 5000, [100]);
  const { service: fresh } = { service: createService(db, { now: () => NOW + 6000 }) };
  assert.deepEqual(fresh.getCheckLatency("a")?.days, live?.days);
});

test("latency: the cache is reused for 5 s and a new result clears it", () => {
  let t = NOW;
  const { service } = setup(() => t);
  const first = service.getLatency();
  assert.equal(service.getLatency(), first);
  assert.equal(service.getCheckLatency("a"), service.getCheckLatency("a"));
  service.ingest({
    checkId: "a",
    timestamp: t,
    status: "up",
    statusCode: 200,
    latencyMs: 12,
    reason: null,
    location: "default",
    attempts: 1,
  });
  const after = service.getLatency();
  assert.notEqual(after, first);
  assert.equal(day(after[0] as CheckLatency, 0)?.p50Ms, 12);
  t += 6000;
  assert.notEqual(service.getLatency(), after);
});

type RollupService = LatencyRollupDeps["service"];
interface FillCall {
  id: string;
  day: number;
  isStored: boolean;
}
interface Timer {
  fn: () => Promise<void>;
  ms: number;
  isCleared: boolean;
}

/** Passes through to the service and records every fill call. */
function spyService(service: RollupService) {
  const calls: FillCall[] = [];
  const spy: RollupService = {
    listLatencyCheckIds: () => service.listLatencyCheckIds(),
    missingLatencyDays: (id) => service.missingLatencyDays(id),
    fillLatencyRollupDay: (id, d) => {
      const isStored = service.fillLatencyRollupDay(id, d);
      calls.push({ id, day: d, isStored });
      return isStored;
    },
  };
  return { spy, calls };
}

function runnerDeps(service: RollupService, extra: Partial<LatencyRollupDeps> = {}) {
  const timers: Timer[] = [];
  const logs: string[] = [];
  const deps: LatencyRollupDeps = {
    service,
    sleep: () => Promise.resolve(),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, isCleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const timer = timers.find((t) => t === handle);
      if (timer) timer.isCleared = true;
    },
    log: (m) => logs.push(m),
    now: () => NOW,
    ...extra,
  };
  return { deps, timers, logs };
}

async function fire(timers: Timer[], i: number): Promise<void> {
  const timer = timers[i];
  assert.ok(timer, `timer ${i} exists`);
  await timer.fn();
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A sleep that blocks at the k-th yield until released. */
function pausingSleep(k: number) {
  let yields = 0;
  let release: () => void = () => undefined;
  let onPaused: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    onPaused = resolve;
  });
  const sleep = (): Promise<void> => {
    yields++;
    if (yields !== k) return Promise.resolve();
    onPaused();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return { sleep, paused, release: () => release() };
}

const rowCount = (db: ReturnType<typeof setup>["db"]): unknown =>
  db.query("SELECT COUNT(*) AS n FROM latency_daily").get();

test("rollup runner: the first run waits for the start delay, then runs hourly", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const { deps, timers } = runnerDeps(spy);
  const runner = startLatencyRollup(deps);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [5000],
  );
  await settle();
  assert.equal(calls.length, 0, "no fill call before the delay timer fires");
  await fire(timers, 0);
  assert.equal(calls.length, 178);
  assert.equal(timers[1]?.ms, 3_600_000);
  await runner.stop();
  await fire(timers, 1);
  assert.equal(timers.length, 2);

  const custom = runnerDeps(spy, { startDelayMs: 250 });
  await startLatencyRollup(custom.deps).stop();
  assert.deepEqual(
    custom.timers.map((t) => t.ms),
    [250],
  );
});

test("rollup backfill: one fill per (check, day), each followed by a sleep(0)", async () => {
  const { service, add } = setup();
  add(TODAY - DAY + 1000, [8]);
  const { spy, calls } = spyService(service);
  const yieldsAfter: number[] = [];
  const result = await fillAllRollups({
    service: spy,
    sleep: (ms) => {
      assert.equal(ms, 0);
      yieldsAfter.push(calls.length);
      return Promise.resolve();
    },
  });
  assert.deepEqual(result, { checks: 2, written: 178 });
  assert.equal(calls.length, 178);
  assert.equal(new Set(calls.map((c) => `${c.id}:${c.day}`)).size, 178);
  assert.deepEqual(
    yieldsAfter,
    Array.from({ length: 178 }, (_, i) => i + 1),
  );
  assert.equal(day(service.getCheckLatency("a") as CheckLatency, 1)?.p50Ms, 8);
});

test("rollup backfill: a restart on a complete table computes nothing; after midnight one day per check", async () => {
  const { db, service, add } = setup();
  add(TODAY - DAY + 1000, [8]);
  const first = runnerDeps(service);
  const r1 = startLatencyRollup(first.deps);
  await fire(first.timers, 0);
  await r1.stop();
  assert.deepEqual(rowCount(db), { n: 178 });

  const sameDay = spyService(createService(db, { now: () => NOW + 3_600_000 }));
  const second = runnerDeps(sameDay.spy);
  const r2 = startLatencyRollup(second.deps);
  await fire(second.timers, 0);
  await r2.stop();
  assert.equal(sameDay.calls.length, 0);
  assert.deepEqual(rowCount(db), { n: 178 });
  assert.match(second.logs[1] ?? "", /^latency rollup: backfill done, stored 0 days in \d+ ms$/);

  const nextDay = spyService(createService(db, { now: () => NOW + DAY }));
  const third = runnerDeps(nextDay.spy);
  const r3 = startLatencyRollup(third.deps);
  await fire(third.timers, 0);
  await r3.stop();
  assert.deepEqual(nextDay.calls, [
    { id: "a", day: TODAY / DAY, isStored: true },
    { id: "b", day: TODAY / DAY, isStored: true },
  ]);
  assert.match(third.logs[1] ?? "", /^latency rollup: backfill done, stored 2 days in \d+ ms$/);
});

test("rollup backfill: a day stored by a read during a pause is skipped, no duplicates", async () => {
  const { db, service, add } = setup();
  add(TODAY - 10 * DAY + 1000, [5, 7]);
  const { spy, calls } = spyService(service);
  const gate = pausingSleep(1);
  const { deps, timers, logs } = runnerDeps(spy, { sleep: gate.sleep });
  startLatencyRollup(deps);
  const running = fire(timers, 0);
  await gate.paused;
  assert.deepEqual(
    calls.map((c) => c.isStored),
    [true],
  );
  // The read stores the remaining closed days of "a", including TODAY - 10 days.
  service.getCheckLatency("a");
  gate.release();
  await running;
  const aCalls = calls.filter((c) => c.id === "a");
  assert.equal(aCalls.length, 89);
  assert.ok(aCalls.slice(1).every((c) => !c.isStored));
  assert.ok(aCalls.some((c) => c.day === (TODAY - 10 * DAY) / DAY && !c.isStored));
  assert.equal(calls.filter((c) => c.id === "b" && c.isStored).length, 89);
  assert.equal(logs[1], "latency rollup: backfill done, stored 90 days in 0 ms");
  const perCheck = db
    .query(
      "SELECT check_id AS id, COUNT(*) AS n, COUNT(DISTINCT day) AS days FROM latency_daily GROUP BY check_id ORDER BY check_id",
    )
    .all();
  assert.deepEqual(perCheck, [
    { id: "a", n: 89, days: 89 },
    { id: "b", n: 89, days: 89 },
  ]);
  const row = db
    .query("SELECT p50_ms, p95_ms, count FROM latency_daily WHERE check_id = 'a' AND day = ?")
    .get((TODAY - 10 * DAY) / DAY);
  assert.deepEqual(row, { p50_ms: 5, p95_ms: 7, count: 2 });
});

function setupFixture(clock: () => number) {
  const fixture = setup(clock, { availabilityTargets: () => new Map([["a", 99.5]]) });
  const { add } = fixture;
  add(TODAY - 30 * DAY + 1000, [40, 10, 30, 20]);
  add(TODAY - 5 * DAY + 1000, [100, 300, 200]);
  add(TODAY - 3 * DAY + 1000, [999, 999], "down");
  add(TODAY + 1000, [12, 14]);
  add(TODAY - 5 * DAY + 1000, [7, 9], "up", "b");
  add(TODAY - 60 * DAY + 5000, [55], "degraded", "b");
  add(TODAY + 1000, [3], "up", "b");
  return fixture;
}

async function snapshot(base: string) {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const checks = (await get("/checks")) as ChecksResponse;
  return {
    latency: await get("/latency"),
    checkLatency: await get("/checks/a/latency"),
    slo: checks.map((c) => ({ id: c.id, slo: c.slo })),
  };
}

test("http: responses are identical before, during and after the backfill", async () => {
  let t = NOW;
  const clock = () => t;
  const fresh = setupFixture(clock);
  const freshApi = await listen(fresh.service, clock);
  const { service } = setupFixture(clock);
  const api = await listen(service, clock);
  try {
    const before = await snapshot(freshApi.base);
    const { spy, calls } = spyService(service);
    const gate = pausingSleep(45);
    const { deps, timers } = runnerDeps(spy, { sleep: gate.sleep, now: clock });
    startLatencyRollup(deps);
    const running = fire(timers, 0);
    await gate.paused;
    assert.equal(calls.length, 45);
    assert.ok(calls.every((c) => c.id === "a" && c.isStored));
    t += 6000;
    const during = await snapshot(api.base);
    gate.release();
    await running;
    assert.ok(calls.length > 45, "batches ran after the read");
    t += 6000;
    const after = await snapshot(api.base);
    assert.ok(before.slo.find((s) => s.id === "a")?.slo, "the target check carries slo");
    const a = before.checkLatency as CheckLatency;
    assert.deepEqual(day(a, 3), { date: "2026-10-25", p50Ms: null, p95Ms: null, count: 0 });
    assert.deepEqual(day(a, 5), { date: "2026-10-23", p50Ms: 200, p95Ms: 300, count: 3 });
    assert.deepEqual(during, before);
    assert.deepEqual(after, before);
  } finally {
    await freshApi.close();
    await api.close();
  }
});

test("rollup logs: start and done with an integer duration; hourly only when days were stored", async () => {
  const { db, service } = setup();
  let t = 0;
  const { deps, timers, logs } = runnerDeps(service, {
    now: () => {
      const value = t;
      t += 1233.6;
      return value;
    },
  });
  startLatencyRollup(deps);
  await fire(timers, 0);
  assert.deepEqual(logs, [
    "latency rollup: backfill started (2 checks)",
    "latency rollup: backfill done, stored 178 days in 1234 ms",
  ]);
  await fire(timers, 1);
  assert.equal(logs.length, 2, "an hourly run with 0 days logs nothing");
  db.run("DELETE FROM latency_daily WHERE check_id = 'a' AND day >= ?", [TODAY / DAY - 3]);
  await fire(timers, 2);
  assert.deepEqual(logs.slice(2), ["latency rollup: stored 3 days in 1234 ms"]);
});

test("rollup logs: a failed run logs the error and no done line", async () => {
  const { service } = setup();
  const failing: RollupService = {
    listLatencyCheckIds: () => service.listLatencyCheckIds(),
    missingLatencyDays: () => {
      throw new Error("boom");
    },
    fillLatencyRollupDay: () => true,
  };
  const { deps, timers, logs } = runnerDeps(failing);
  startLatencyRollup(deps);
  await fire(timers, 0);
  assert.deepEqual(logs, [
    "latency rollup: backfill started (2 checks)",
    "latency rollup failed: boom",
  ]);
  assert.equal(timers[1]?.ms, 3_600_000);
});

test("rollup shutdown: stop during the delay clears the timer and resolves at once", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const { deps, timers, logs } = runnerDeps(spy);
  const runner = startLatencyRollup(deps);
  await runner.stop();
  assert.equal(timers[0]?.isCleared, true);
  await fire(timers, 0);
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 1);
  assert.deepEqual(logs, []);
});

test("rollup shutdown: stop during a paused batch resolves after it, with no further fill", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const gate = pausingSleep(3);
  const { deps, timers } = runnerDeps(spy, { sleep: gate.sleep });
  const runner = startLatencyRollup(deps);
  const running = fire(timers, 0);
  await gate.paused;
  let isStopped = false;
  const stopping = runner.stop().then(() => {
    isStopped = true;
  });
  await settle();
  assert.equal(isStopped, false, "stop waits for the batch in progress");
  gate.release();
  await stopping;
  await running;
  assert.equal(calls.length, 3);
  assert.equal(timers.length, 1, "no run is scheduled after stop");
});

test("rollup day: today and later are refused; a stored day is not filled again", () => {
  const { db, service, add } = setup();
  add(TODAY + 1000, [5]);
  add(TODAY - DAY + 1000, [6]);
  const today = TODAY / DAY;
  assert.equal(service.fillLatencyRollupDay("a", today), false);
  assert.equal(service.fillLatencyRollupDay("a", today + 1), false);
  assert.deepEqual(rowCount(db), { n: 0 });
  const missing = service.missingLatencyDays("a");
  assert.equal(missing.length, 89);
  assert.equal(missing[0], today - 89);
  assert.equal(missing.at(-1), today - 1);
  assert.equal(service.fillLatencyRollupDay("a", today - 1), true);
  // A stored day is skipped before its results are read: any query on them would throw now.
  db.run("ALTER TABLE results RENAME TO results_gone");
  assert.equal(service.fillLatencyRollupDay("a", today - 1), false);
  db.run("ALTER TABLE results_gone RENAME TO results");
  assert.deepEqual(rowCount(db), { n: 1 });
  assert.equal(service.missingLatencyDays("a").length, 88);
});

test("retention: rollups before the cutoff day and of removed checks are deleted, the window stays", async () => {
  const { db, service } = setup();
  service.getLatency();
  db.run("INSERT INTO latency_daily VALUES ('gone', ?, 1, 1, 1)", [TODAY / DAY - 5]);
  db.run("INSERT INTO latency_daily VALUES ('a', ?, 1, 1, 1)", [TODAY / DAY - 200]);
  const deleted = await cleanupResults(service, {
    now: () => NOW,
    retentionDays: 90,
    sleep: () => Promise.resolve(),
    deleteLatencyRollups: (cutoff) => service.deleteExpiredLatency(cutoff),
  });
  assert.equal(deleted, 2);
  const n = db.query("SELECT COUNT(*) AS n FROM latency_daily").get();
  assert.deepEqual(n, { n: 2 * 89 });
});

async function listen(service: ReturnType<typeof setup>["service"], now: () => number = () => NOW) {
  const server = createApiServer(service, { tokens: [], now });
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

test("http: GET /latency and GET /checks/:id/latency", async () => {
  const { service, add } = setup();
  add(TODAY + 1000, [5, 6, 7]);
  const api = await listen(service);
  try {
    const all = await fetch(`${api.base}/latency`);
    assert.equal(all.status, 200);
    const list = (await all.json()) as CheckLatency[];
    assert.deepEqual(
      list.map((l) => l.checkId),
      ["a", "b"],
    );
    const one = await fetch(`${api.base}/checks/a/latency`);
    assert.equal(one.status, 200);
    const body = (await one.json()) as CheckLatency;
    assert.equal(validateCheckLatency(body).ok, true);
    assert.equal(day(body, 0)?.count, 3);
    for (const id of ["hb", "tls", "nope"]) {
      const res = await fetch(`${api.base}/checks/${id}/latency`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "unknown check" });
    }
    assert.equal((await fetch(`${api.base}/checks/%E0%A4%A/latency`)).status, 400);
    assert.equal((await fetch(`${api.base}/latency`, { method: "POST" })).status, 405);
  } finally {
    await api.close();
  }
});

test("http: the route label of the metric is a template", async () => {
  const { service } = setup();
  const api = await listen(service);
  try {
    await fetch(`${api.base}/checks/a/latency`);
    await fetch(`${api.base}/latency`);
    const text = await (await fetch(`${api.base}/metrics`)).text();
    assert.match(text, /route="\/checks\/:id\/latency",code="200"/);
    assert.match(text, /route="\/latency",code="200"/);
  } finally {
    await api.close();
  }
});
