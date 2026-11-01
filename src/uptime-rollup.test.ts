import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type {
  ChecksResponse,
  CheckUptime,
  Component,
  ComponentUptime,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService, type Service } from "./service.ts";
import { fillAllUptimeDays, startUptimeRollup, type UptimeRollupDeps } from "./uptime-rollup.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");
const TODAY_DAY = TODAY / DAY;
/** Three active checks with 89 closed days each. */
const ALL_DAYS = 3 * 89;

function setup(now: () => number = () => NOW) {
  const db = openDb(":memory:");
  const service = createService(db, {
    now,
    availabilityTargets: () => new Map([["a", 99.5]]),
  });
  service.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
    { id: "b", name: "B", url: "http://b/", intervalMs: 60_000 },
    { id: "hb", name: "HB", type: "heartbeat", period: 60_000, grace: 1000 },
  ]);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES (?, ?, ?, 1, ?)",
  );
  const add = (t: number, status: string, n = 1, id = "a", loc = "default") => {
    for (let i = 0; i < n; i++) insert.run(id, t + i, status, loc);
  };
  return { db, service, add };
}

type RollupService = UptimeRollupDeps["service"];
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
    listUptimeCheckIds: () => service.listUptimeCheckIds(),
    missingUptimeDays: (id) => service.missingUptimeDays(id),
    fillUptimeDay: (id, d) => {
      const isStored = service.fillUptimeDay(id, d);
      calls.push({ id, day: d, isStored });
      return isStored;
    },
  };
  return { spy, calls };
}

function runnerDeps(service: RollupService, extra: Partial<UptimeRollupDeps> = {}) {
  const timers: Timer[] = [];
  const logs: string[] = [];
  const deps: UptimeRollupDeps = {
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
  db.query("SELECT COUNT(*) AS n FROM uptime_daily").get();

test("uptime runner: the first run waits for the start delay, then runs hourly", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const { deps, timers } = runnerDeps(spy);
  const runner = startUptimeRollup(deps);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [5000],
  );
  await settle();
  assert.equal(calls.length, 0, "no fill call before the delay timer fires");
  await fire(timers, 0);
  assert.equal(calls.length, ALL_DAYS);
  assert.equal(timers[1]?.ms, 3_600_000);
  await runner.stop();
  await fire(timers, 1);
  assert.equal(timers.length, 2);

  const custom = runnerDeps(spy, { startDelayMs: 250, intervalMs: 10 });
  const second = startUptimeRollup(custom.deps);
  await fire(custom.timers, 0);
  await second.stop();
  assert.deepEqual(
    custom.timers.map((t) => t.ms),
    [250, 10],
  );
});

test("uptime backfill: one fill per (check, day), each followed by a sleep(0)", async () => {
  const { service, add } = setup();
  add(TODAY - DAY + 1000, "up", 3);
  add(TODAY - DAY + 5000, "down", 1);
  const { spy, calls } = spyService(service);
  const yieldsAfter: number[] = [];
  const result = await fillAllUptimeDays({
    service: spy,
    sleep: (ms) => {
      assert.equal(ms, 0);
      yieldsAfter.push(calls.length);
      return Promise.resolve();
    },
  });
  assert.deepEqual(result, { checks: 3, written: ALL_DAYS });
  assert.equal(new Set(calls.map((c) => `${c.id}:${c.day}`)).size, ALL_DAYS);
  assert.deepEqual(
    yieldsAfter,
    Array.from({ length: ALL_DAYS }, (_, i) => i + 1),
  );
  assert.equal(service.getUptime()[0]?.days[88]?.uptime, 75);
});

test("uptime backfill: a restart on a complete table computes nothing; after midnight one day per check", async () => {
  const { db, service } = setup();
  const first = runnerDeps(service);
  const r1 = startUptimeRollup(first.deps);
  await fire(first.timers, 0);
  await r1.stop();
  assert.deepEqual(rowCount(db), { n: ALL_DAYS });

  const sameDay = spyService(createService(db, { now: () => NOW + 3_600_000 }));
  const second = runnerDeps(sameDay.spy);
  const r2 = startUptimeRollup(second.deps);
  await fire(second.timers, 0);
  await r2.stop();
  assert.equal(sameDay.calls.length, 0);
  assert.equal(second.logs[1], "uptime rollup: backfill done, stored 0 days in 0 ms");

  const nextDay = spyService(createService(db, { now: () => NOW + DAY }));
  const third = runnerDeps(nextDay.spy);
  const r3 = startUptimeRollup(third.deps);
  await fire(third.timers, 0);
  await r3.stop();
  assert.deepEqual(nextDay.calls, [
    { id: "a", day: TODAY_DAY, isStored: true },
    { id: "b", day: TODAY_DAY, isStored: true },
    { id: "hb", day: TODAY_DAY, isStored: true },
  ]);
  assert.equal(third.logs[1], "uptime rollup: backfill done, stored 3 days in 0 ms");
});

test("uptime backfill: a day stored by a read during a pause is skipped, no duplicates", async () => {
  const { db, service, add } = setup();
  add(TODAY - 10 * DAY + 1000, "up", 1);
  add(TODAY - 10 * DAY + 2000, "down", 1);
  const { spy, calls } = spyService(service);
  const gate = pausingSleep(1);
  const { deps, timers, logs } = runnerDeps(spy, { sleep: gate.sleep });
  startUptimeRollup(deps);
  const running = fire(timers, 0);
  await gate.paused;
  // The read stores the other closed days of every check, including TODAY - 10 days of "a".
  service.getUptime();
  gate.release();
  await running;
  assert.equal(calls.filter((c) => c.isStored).length, 1);
  assert.equal(logs[1], "uptime rollup: backfill done, stored 1 days in 0 ms");
  const perCheck = db
    .query(
      "SELECT check_id AS id, COUNT(*) AS n, COUNT(DISTINCT day) AS days FROM uptime_daily GROUP BY check_id ORDER BY check_id",
    )
    .all();
  assert.deepEqual(perCheck, [
    { id: "a", n: 89, days: 89 },
    { id: "b", n: 89, days: 89 },
    { id: "hb", n: 89, days: 89 },
  ]);
  const row = db
    .query("SELECT good, total FROM uptime_daily WHERE check_id = 'a' AND day = ?")
    .get(TODAY_DAY - 10);
  assert.deepEqual(row, { good: 1, total: 2 });
});

test("uptime logs: start and done with an integer duration; hourly only when days were stored", async () => {
  const { db, service } = setup();
  let t = 0;
  const { deps, timers, logs } = runnerDeps(service, {
    now: () => {
      const value = t;
      t += 1233.6;
      return value;
    },
  });
  startUptimeRollup(deps);
  await fire(timers, 0);
  assert.deepEqual(logs, [
    "uptime rollup: backfill started (3 checks)",
    "uptime rollup: backfill done, stored 267 days in 1234 ms",
  ]);
  await fire(timers, 1);
  assert.equal(logs.length, 2, "an hourly run with 0 days logs nothing");
  db.run("DELETE FROM uptime_daily WHERE check_id = 'a' AND day >= ?", [TODAY_DAY - 3]);
  await fire(timers, 2);
  assert.deepEqual(logs.slice(2), ["uptime rollup: stored 3 days in 1234 ms"]);
});

test("uptime logs: a failed run logs the error and no done line, and the next run is scheduled", async () => {
  const { service } = setup();
  const failing: RollupService = {
    listUptimeCheckIds: () => service.listUptimeCheckIds(),
    missingUptimeDays: () => {
      throw new Error("boom");
    },
    fillUptimeDay: () => true,
  };
  const { deps, timers, logs } = runnerDeps(failing);
  startUptimeRollup(deps);
  await fire(timers, 0);
  assert.deepEqual(logs, [
    "uptime rollup: backfill started (3 checks)",
    "uptime rollup failed: boom",
  ]);
  assert.equal(timers[1]?.ms, 3_600_000);

  const odd = runnerDeps({
    ...failing,
    missingUptimeDays: () => {
      throw "text";
    },
  });
  startUptimeRollup(odd.deps);
  await fire(odd.timers, 0);
  assert.equal(odd.logs[1], "uptime rollup failed: unknown error");
});

test("uptime shutdown: stop during the delay clears the timer and resolves at once", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const { deps, timers, logs } = runnerDeps(spy);
  const runner = startUptimeRollup(deps);
  await runner.stop();
  await runner.done;
  assert.equal(timers[0]?.isCleared, true);
  await fire(timers, 0);
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 1);
  assert.deepEqual(logs, []);
});

test("uptime shutdown: stop during a paused batch resolves after it, with no further fill", async () => {
  const { service } = setup();
  const { spy, calls } = spyService(service);
  const gate = pausingSleep(3);
  const { deps, timers } = runnerDeps(spy, { sleep: gate.sleep });
  const runner = startUptimeRollup(deps);
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

const components: Component[] = [
  { id: "front", name: "Front", checkIds: ["a", "hb"] },
  { id: "back", name: "Back", checkIds: ["b"] },
];

async function listen(service: Service, now: () => number) {
  const server = createApiServer(service, { now, components: () => components });
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

function setupFixture(clock: () => number) {
  const fixture = setup(clock);
  const { add } = fixture;
  add(TODAY - 80 * DAY + 1000, "up", 4);
  add(TODAY - 29 * DAY + 1000, "down", 1);
  add(TODAY - 5 * DAY + 1000, "up", 3, "a", "eu");
  add(TODAY - 5 * DAY + 1000, "degraded", 2, "a", "us");
  add(TODAY - 3 * DAY + 1000, "down", 2);
  add(TODAY + 1000, "up", 2);
  add(TODAY - 5 * DAY + 1000, "up", 1, "b");
  add(TODAY - 60 * DAY + 5000, "down", 1, "b");
  add(TODAY - 2 * DAY + 5000, "up", 3, "hb", "heartbeat");
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
    uptime: (await get("/uptime")) as CheckUptime[],
    components: (await get("/components/uptime")) as ComponentUptime[],
    slo: checks.map((c) => ({ id: c.id, slo: c.slo })),
  };
}

test("http: GET /uptime, /components/uptime and /checks are identical before, during and after the backfill", async () => {
  let t = NOW;
  const clock = () => t;
  const fresh = setupFixture(clock);
  const freshApi = await listen(fresh.service, clock);
  const { db, service } = setupFixture(clock);
  try {
    const before = await snapshot(freshApi.base);
    const { spy, calls } = spyService(service);
    const gate = pausingSleep(120);
    const { deps, timers } = runnerDeps(spy, { sleep: gate.sleep, now: clock });
    startUptimeRollup(deps);
    const running = fire(timers, 0);
    await gate.paused;
    assert.equal(calls.length, 120);
    // A restart while the backfill is in progress: some days have rows, the rest are filled on read.
    const during = await (async () => {
      const api = await listen(
        createService(db, { now: clock, availabilityTargets: () => new Map([["a", 99.5]]) }),
        clock,
      );
      try {
        return await snapshot(api.base);
      } finally {
        await api.close();
      }
    })();
    gate.release();
    await running;
    assert.deepEqual(rowCount(db), { n: ALL_DAYS });
    t += 6000;
    const restarted = createService(db, {
      now: clock,
      availabilityTargets: () => new Map([["a", 99.5]]),
    });
    const afterApi = await listen(restarted, clock);
    const after = await (async () => {
      try {
        return await snapshot(afterApi.base);
      } finally {
        await afterApi.close();
      }
    })();
    const a = before.uptime[0];
    assert.equal(a?.days[84]?.results, 5);
    assert.equal(a?.days[84]?.uptime, 100);
    assert.equal(a?.days[86]?.uptime, 0);
    assert.ok(before.slo.find((s) => s.id === "a")?.slo, "the target check carries slo");
    assert.deepEqual(during, before);
    assert.deepEqual(after, before);
  } finally {
    await freshApi.close();
  }
});
