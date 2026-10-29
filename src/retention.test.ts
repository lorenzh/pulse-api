import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { CheckUptime } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import {
  cleanupResults,
  parseRetentionDays,
  RETENTION_INTERVAL_MS,
  retentionCutoff,
  startRetention,
} from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const service = createService(db, { now: () => NOW });
  service.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture
    { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
  ]);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES ('a', ?, ?, 1, ?)",
  );
  for (const loc of ["eu", "us"]) {
    for (const d of [100, 91, 89, 0]) insert.run(TODAY - d * DAY + 1000, "up", loc);
  }
  // Future-dated result is never deleted.
  insert.run(NOW + DAY, "up", "eu");
  db.exec(
    "INSERT INTO incidents (check_id, opened_at, resolved_at) VALUES ('a', 1, 2), ('a', 3, NULL)",
  );
  const timestamps = (): number[] =>
    (
      db.prepare("SELECT timestamp FROM results ORDER BY timestamp, id").all() as {
        timestamp: number;
      }[]
    ).map((r) => r.timestamp);
  return { db, service, timestamps };
}

const sleepFake =
  (calls: number[]) =>
  (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };

test("parseRetentionDays: default and invalid values", () => {
  assert.equal(parseRetentionDays(undefined), 90);
  assert.equal(parseRetentionDays(""), 90);
  assert.equal(parseRetentionDays("365"), 365);
  for (const bad of ["89", "0", "-1", "1.5", "abc"]) {
    assert.throws(() => parseRetentionDays(bad), /PULSE_RETENTION_DAYS.*90/);
  }
});

test("retentionCutoff: day aligned, equals first uptime day for 90", () => {
  assert.equal(retentionCutoff(NOW, 90), TODAY - 89 * DAY);
});

test("cleanup removes old rows but keeps newest per location, future rows and incidents", async () => {
  const { service, db, timestamps } = setup();
  const before = service.getUptime();
  const deleted = await cleanupResults(service, {
    now: () => NOW,
    retentionDays: 90,
    sleep: sleepFake([]),
  });
  // -100 and -91 deleted for both locations; -89 and today kept.
  assert.equal(deleted, 4);
  assert.equal(timestamps().length, 5);
  assert.ok(timestamps().every((t) => t >= TODAY - 89 * DAY));
  assert.deepEqual(service.getUptime(), before);
  assert.equal(service.listIncidents().length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM results WHERE timestamp > ?").get(NOW)?.n, 1);
});

test("a silent location keeps its newest result", async () => {
  const { service, db } = setup();
  db.exec(
    "DELETE FROM results WHERE location = 'us' AND timestamp > 0 AND timestamp > " +
      (TODAY - 90 * DAY),
  );
  await cleanupResults(service, { now: () => NOW, retentionDays: 90, sleep: sleepFake([]) });
  const us = service.listChecks()[0]?.locations.find((l) => l.location === "us");
  assert.equal(us?.result.timestamp, TODAY - 91 * DAY + 1000);
});

test("small batches: several batches, sleep between them", async () => {
  const { service, timestamps } = setup();
  const calls: number[] = [];
  const deleted = await cleanupResults(service, {
    now: () => NOW,
    retentionDays: 90,
    batchSize: 1,
    sleep: sleepFake(calls),
  });
  assert.equal(deleted, 4);
  assert.equal(timestamps().length, 5);
  assert.equal(calls.length, 4);
});

test("scheduler: runs at startup and hourly, errors do not stop it", async () => {
  const timers: { fn: () => Promise<void>; ms: number }[] = [];
  const logs: string[] = [];
  let fail = true;
  let result = 3;
  const service = {
    deleteExpiredResults(): number {
      if (fail) throw new Error("disk full");
      const r = result;
      result = 0;
      return r;
    },
  };
  const r = startRetention({
    service,
    now: () => NOW,
    retentionDays: 90,
    sleep: sleepFake([]),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    log: (m) => logs.push(m),
  });
  await r.done;
  assert.deepEqual(logs, ["retention failed: disk full"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, RETENTION_INTERVAL_MS);
  fail = false;
  await timers[0]?.fn();
  assert.deepEqual(logs[1], "retention: deleted 3 results");
  assert.equal(timers.length, 2);
  r.stop();
});

test("GET /uptime is identical before and after cleanup", async (t) => {
  const { service } = setup();
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/uptime`;
  const get = async (): Promise<CheckUptime[]> =>
    (await fetch(url)).json() as Promise<CheckUptime[]>;
  const before = await get();
  await cleanupResults(service, { now: () => NOW, retentionDays: 90, sleep: sleepFake([]) });
  assert.deepEqual(await get(), before);
});
