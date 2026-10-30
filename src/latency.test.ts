import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { type CheckLatency, validateCheckLatency } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { nearestRank } from "./latency.ts";
import { fillAllRollups, startLatencyRollup } from "./latency-rollup.ts";
import { cleanupResults } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");

function setup(now: () => number = () => NOW) {
  const db = openDb(":memory:");
  const service = createService(db, { now });
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

test("latency: backfill fills closed days off the request path", async () => {
  const { db, service, add } = setup();
  add(TODAY - DAY + 1000, [8]);
  const written = await fillAllRollups({ service, sleep: () => Promise.resolve() });
  assert.equal(written, 2 * 89);
  assert.equal(await fillAllRollups({ service, sleep: () => Promise.resolve() }), 0);
  const row = db
    .query("SELECT p50_ms FROM latency_daily WHERE check_id = 'a' AND day = ?")
    .get((TODAY - DAY) / DAY);
  assert.deepEqual(row, { p50_ms: 8 });
});

test("latency: the runner starts on the next turn and repeats on its interval", async () => {
  const { service } = setup();
  const timers: { fn: () => Promise<void>; ms: number }[] = [];
  const logs: string[] = [];
  const runner = startLatencyRollup({
    service,
    sleep: () => Promise.resolve(),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    log: (m) => logs.push(m),
  });
  assert.equal(timers[0]?.ms, 0);
  await timers[0]?.fn();
  assert.deepEqual(logs, ["latency rollup: stored 178 days"]);
  assert.equal(timers[1]?.ms, 3_600_000);
  await runner.stop();
  await timers[1]?.fn();
  assert.equal(timers.length, 2);
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

async function listen(service: ReturnType<typeof setup>["service"]) {
  const server = createApiServer(service, { tokens: [], now: () => NOW });
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
