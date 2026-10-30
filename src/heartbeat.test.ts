import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import {
  createHeartbeatEvaluator,
  HEARTBEAT_TICK_MS,
  startHeartbeatEvaluator,
} from "./heartbeat.ts";
import { createMetrics } from "./metrics.ts";
import { createService, HEARTBEAT_LOCATION } from "./service.ts";

const PERIOD = 2000;
const GRACE = 1000;
const hb = { id: "job", name: "Job", type: "heartbeat", period: PERIOD, grace: GRACE } as const;

function ping(t: number): Result {
  return {
    checkId: "job",
    timestamp: t,
    status: "up",
    statusCode: null,
    latencyMs: 0,
    reason: null,
    location: HEARTBEAT_LOCATION,
    attempts: 1,
  };
}

function setup(maintenance: { checkId: string; start: number; end: number; note: string }[] = []) {
  let t = 100_000;
  const events: string[] = [];
  const metrics = createMetrics();
  const db = openDb(":memory:");
  const service = createService(db, {
    now: () => t,
    maintenance,
    onIncident: (e) => events.push(e),
  });
  service.upsertChecks([hb]);
  const evaluator = createHeartbeatEvaluator({ service, metrics, now: () => t });
  return {
    service,
    metrics,
    evaluator,
    events,
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

const state = (s: ReturnType<typeof setup>) => s.service.listChecks()[0];

test("before the first ping: unknown until period + grace, then one down and one incident", () => {
  const s = setup();
  s.evaluator.tick();
  s.advance(PERIOD + GRACE);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "unknown");
  s.advance(1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "down");
  assert.equal(state(s)?.lastResultAt, null);
  assert.equal(state(s)?.lastReason, `no ping within ${PERIOD + GRACE}ms`);
  assert.deepEqual(s.events, ["opened"]);
  assert.equal(s.service.listIncidents("open").length, 1);
});

test("repeated ticks during one outage write one down result; missed periods are counted", () => {
  const s = setup();
  s.evaluator.tick();
  for (let i = 0; i < 10; i++) {
    s.advance(1000);
    s.evaluator.tick();
  }
  assert.equal(s.service.listResults("job", 100).length, 1);
  assert.equal(s.service.listIncidents().length, 1);
  const text = s.metrics.render();
  assert.match(text, /pulse_heartbeat_missed_total\{check="job"\} 4\n/);
  assert.match(text, /pulse_heartbeat_pings_total\{check="job"\} 0\n/);
});

test("a ping resolves the incident and restarts the wait; lastResultAt is the ping", () => {
  const s = setup();
  s.evaluator.tick();
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  s.advance(5000);
  s.service.ingest(ping(s.at()));
  assert.equal(state(s)?.state, "up");
  assert.equal(state(s)?.lastResultAt, s.at());
  assert.deepEqual(s.events, ["opened", "resolved"]);
  s.advance(PERIOD + GRACE);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "up");
  s.advance(1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "down");
  assert.equal(s.service.listIncidents("open").length, 1);
});

test("a down result never moves the last ping", () => {
  const s = setup();
  s.service.ingest(ping(s.at()));
  const ping1 = s.at();
  s.evaluator.tick();
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "down");
  assert.equal(state(s)?.lastResultAt, ping1);
});

test("after a restart the persisted ping counts but the api downtime opens no incident", () => {
  const s = setup();
  s.service.ingest(ping(s.at()));
  s.advance(60_000); // the api was away
  const again = createHeartbeatEvaluator({
    service: s.service,
    metrics: createMetrics(),
    now: s.at,
  });
  again.tick();
  assert.equal(state(s)?.state, "up");
  s.advance(PERIOD + GRACE);
  again.tick();
  assert.equal(state(s)?.state, "up");
  s.advance(1);
  again.tick();
  assert.equal(state(s)?.state, "down");
});

test("maintenance: no down result is written", () => {
  const s = setup([{ checkId: "job", start: 0, end: 1_000_000, note: "n" }]);
  s.evaluator.tick();
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  assert.equal(s.service.listResults("job", 10).length, 0);
  assert.equal(state(s)?.state, "maintenance");
  assert.equal(s.service.listIncidents().length, 0);
});

test("a removed check is dropped; a changed period restarts the wait and keeps the last ping", () => {
  const s = setup();
  s.service.ingest(ping(s.at()));
  s.evaluator.tick();
  s.service.upsertChecks([{ ...hb, period: 5000 }]);
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "up");
  assert.equal(state(s)?.lastResultAt, s.at() - PERIOD - GRACE - 1);
  s.service.upsertChecks([]);
  s.advance(100_000);
  s.evaluator.tick();
  assert.equal(s.service.listChecks().length, 0);
});

test("heartbeat result bypasses quorum even with a stale result from another location", () => {
  const s = setup();
  s.service.ingest({ ...ping(s.at()), location: "east", status: "up" });
  s.evaluator.tick();
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "down");
});

test("timer: ticks every second, logs a failing tick, stops", () => {
  const pending: (() => void)[] = [];
  const logs: string[] = [];
  let calls = 0;
  const timer = startHeartbeatEvaluator({
    evaluator: {
      tick() {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    },
    setTimeout: (fn, ms) => {
      assert.equal(ms, HEARTBEAT_TICK_MS);
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => undefined,
    log: (m) => logs.push(m),
  });
  pending.shift()?.();
  pending.shift()?.();
  assert.equal(calls, 2);
  assert.deepEqual(logs, ["heartbeat evaluation failed: boom"]);
  timer.stop();
  pending.shift()?.();
  assert.equal(pending.length, 0);
});

test("the deadline starts when the evaluator starts, not at its first tick", () => {
  const s = setup();
  s.advance(PERIOD + GRACE + 1);
  s.evaluator.tick();
  assert.equal(state(s)?.state, "down");
});
