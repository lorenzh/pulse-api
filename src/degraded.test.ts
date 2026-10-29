import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  Check,
  CheckStatus,
  HttpCheck,
  MaintenanceWindow,
  Result,
} from "@lorenzh/pulse-contract";
import { ConfigError, parseChecks } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiServer, validateResult } from "./server.ts";
import { createService } from "./service.ts";
import { applyResult, INITIAL_STATE, quorumStatus } from "./state.ts";

const base = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };

function res(t: number, status: CheckStatus, location = "default"): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status,
    statusCode: status === "down" ? 503 : 200,
    latencyMs: 5,
    reason: status === "up" ? null : status,
    location,
    attempts: 1,
  };
}

test("config: latencyObjectiveMs accepted, copied and validated", () => {
  const [c] = parseChecks({ checks: [{ ...base, latencyObjectiveMs: 500, extra: 1 }] });
  assert.equal((c as HttpCheck).latencyObjectiveMs, 500);
  assert.equal("extra" in c!, false);
  assert.equal("latencyObjectiveMs" in parseChecks({ checks: [base] })[0]!, false);
  for (const v of [0, -1, 1.5, "5", null]) {
    assert.throws(
      () => parseChecks({ checks: [{ ...base, latencyObjectiveMs: v }] }),
      (e: Error) => e instanceof ConfigError && /latencyObjectiveMs/.test(e.message),
      String(v),
    );
  }
});

test("db: old database migrates; objective is served and can be cleared", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, timeout_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_down INTEGER NOT NULL DEFAULT 0, last_result_at INTEGER, last_reason TEXT);
    INSERT INTO checks (id, name, url, interval_ms) VALUES ('c1', 'C', 'http://x/', 1000);`);
  old.close();
  const s = createService(openDb(path));
  assert.equal("latencyObjectiveMs" in s.listChecks()[0]!, false);
  s.upsertChecks([{ ...check, latencyObjectiveMs: 500 }]);
  assert.equal((s.listChecks()[0] as HttpCheck).latencyObjectiveMs, 500);
  s.upsertChecks([check]);
  assert.equal("latencyObjectiveMs" in s.listChecks()[0]!, false);
});

test("validateResult: degraded accepted, unknown rejected naming all three", () => {
  for (const status of ["up", "degraded", "down"]) {
    assert.equal(typeof validateResult({ ...res(1, "up"), status }, 1), "object", status);
  }
  const err = validateResult({ ...res(1, "up"), status: "slow" }, 1);
  assert.equal(err, 'result.status: must be one of "up", "degraded", "down"');
});

test("server: POST degraded is 204, unknown is 400, GET /checks serves the objective", async () => {
  const service = createService(openDb(":memory:"));
  service.upsertChecks([{ ...check, latencyObjectiveMs: 500 }]);
  const server = createApiServer(service, {
    tokens: [{ location: "default", token: "test-token-default-0123456789" }],
    now: () => 1000,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = (body: unknown) =>
      fetch(`${url}/results`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token-default-0123456789",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(res(1, "degraded"))).status, 204);
    assert.equal((await post({ ...res(2, "up"), status: "slow" })).status, 400);
    const checks = (await (await fetch(`${url}/checks`)).json()) as (HttpCheck & {
      state: string;
    })[];
    assert.equal(checks[0]?.latencyObjectiveMs, 500);
    assert.equal(checks[0]?.state, "degraded");
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
});

test("quorumStatus with degraded", () => {
  const table: Array<[CheckStatus[], CheckStatus]> = [
    [["degraded"], "degraded"],
    [["degraded", "up"], "degraded"],
    [["up", "up", "degraded"], "degraded"],
    [["degraded", "down"], "degraded"],
    [["degraded", "down", "down"], "down"],
    [["down", "down"], "down"],
    [["up", "up"], "up"],
  ];
  for (const [input, want] of table) assert.equal(quorumStatus(input), want, input.join(","));
});

test("state: degraded acts like up for incidents", () => {
  let s = INITIAL_STATE;
  for (const st of ["degraded", "degraded", "degraded"] as const) {
    const r = applyResult(s, st);
    assert.equal(r.action, "none");
    assert.equal(r.next.state, "degraded");
    s = r.next;
  }
  s = INITIAL_STATE;
  s = applyResult(applyResult(s, "down").next, "down").next;
  const r = applyResult(s, "degraded");
  assert.deepEqual(r.next, { state: "degraded", consecutiveDown: 0, incidentOpen: false });
  const after = applyResult(r.next, "down").next;
  assert.equal(after.consecutiveDown, 1);
});

test("service: degraded resolves an open incident", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const t of [1, 2, 3]) s.ingest(res(t, "down"));
  assert.equal(s.listIncidents("open").length, 1);
  s.ingest(res(4, "degraded"));
  assert.equal(s.listIncidents("open").length, 0);
  assert.equal(s.listIncidents("resolved").length, 1);
  assert.equal(s.listChecks()[0]!.state, "degraded");
});

test("service: degraded results open no incident", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const t of [1, 2, 3, 4]) s.ingest(res(t, "degraded"));
  assert.equal(s.listIncidents().length, 0);
  assert.equal(s.listChecks()[0]!.consecutiveDown, 0);
});

test("service: multi-location degraded and maintenance", () => {
  const w: MaintenanceWindow = { checkId: "c1", start: 100, end: 200, note: "n" };
  const clock = { t: 150 };
  const s = createService(openDb(":memory:"), { maintenance: [w], now: () => clock.t });
  s.upsertChecks([check]);
  s.ingest(res(10, "up", "eu"));
  s.ingest(res(11, "degraded", "us"));
  clock.t = 12;
  assert.equal(s.listChecks()[0]!.state, "degraded");
  // inside the window the displayed state is maintenance, degraded follows the normal path
  clock.t = 150;
  s.ingest(res(120, "degraded", "eu"));
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "maintenance");
  assert.equal(s.listIncidents().length, 0);
  clock.t = 300;
  assert.equal(s.listChecks()[0]!.state, "degraded");
});
