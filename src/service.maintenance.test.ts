import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Check, MaintenanceWindow, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
const c1: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
const c2: Check = { id: "c2", name: "C2", url: "http://y/", intervalMs: 1000 };

function res(t: number, status: "up" | "down", checkId = "c1"): Result {
  return {
    checkId,
    timestamp: t,
    status,
    statusCode: status === "up" ? 200 : 503,
    latencyMs: 5,
    reason: status === "down" ? `down@${t}` : null,
    location: "default",
    attempts: 1,
  };
}

const W: MaintenanceWindow = { checkId: "c1", start: 100, end: 200, note: "Upgrade" };

function setup(maintenance: MaintenanceWindow[] = [W]) {
  const clock = { t: 0 };
  const s = createService(openDb(":memory:"), { maintenance, now: () => clock.t });
  s.upsertChecks([c1, c2]);
  return { s, clock };
}

test("maintenance: in-window downs are stored but no state, count or incident", () => {
  const { s } = setup();
  for (const t of [110, 120, 130, 140]) s.ingest(res(t, "down"));
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "unknown");
  assert.equal(c.consecutiveDown, 0);
  assert.equal(c.lastResultAt, 140);
  assert.equal(c.lastReason, "down@140");
  assert.equal(s.listResults("c1", 10).length, 4);
  assert.deepEqual(s.listIncidents(), []);
});

test("maintenance: other checks are not affected by the window", () => {
  const { s } = setup();
  for (const t of [110, 120, 130]) s.ingest(res(t, "down", "c2"));
  assert.equal(s.listIncidents().length, 1);
});

test("maintenance: edges are start-inclusive, end-exclusive", () => {
  const { s } = setup();
  s.ingest(res(99, "down")); // counts
  s.ingest(res(100, "down")); // in window
  s.ingest(res(199, "down")); // in window
  assert.equal(s.listChecks()[0]!.consecutiveDown, 1);
  s.ingest(res(200, "down")); // counts
  s.ingest(res(201, "down")); // counts, opens
  assert.equal(s.listChecks()[0]!.consecutiveDown, 3);
  assert.equal(s.listIncidents().length, 1);
});

test("maintenance: open incident survives in-window downs; in-window up resolves it", () => {
  const { s } = setup();
  for (const t of [10, 20, 30]) s.ingest(res(t, "down"));
  assert.equal(s.listIncidents("open").length, 1);
  for (const t of [110, 120, 130]) s.ingest(res(t, "down"));
  assert.equal(s.listIncidents("open").length, 1);
  assert.equal(s.listChecks()[0]!.consecutiveDown, 3);
  s.ingest(res(150, "up"));
  assert.equal(s.listIncidents("open").length, 0);
  assert.equal(s.listIncidents("resolved")[0]!.resolvedAt, 150);
  assert.equal(s.listChecks()[0]!.consecutiveDown, 0);
});

test("maintenance: listChecks shows maintenance during the window, stored state after", () => {
  const { s, clock } = setup();
  s.ingest(res(10, "up"));
  s.ingest(res(110, "down"));
  clock.t = 99;
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.equal(s.listChecks()[0]!.maintenance, undefined);
  clock.t = 100;
  const during = s.listChecks();
  assert.equal(during[0]!.state, "maintenance");
  assert.deepEqual(during[0]!.maintenance, W);
  assert.equal(during[1]!.state, "unknown");
  clock.t = 200;
  assert.equal(s.listChecks()[0]!.state, "up");
  s.ingest(res(210, "up"));
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.deepEqual(s.listIncidents(), []);
});

test("maintenance: unknown state shows maintenance too; earliest start wins on overlap", () => {
  const second = { ...W, start: 50, end: 150, note: "Earlier" };
  const { s, clock } = setup([W, second]);
  clock.t = 120;
  const c = s.listChecks()[0]!;
  assert.equal(c.state, "maintenance");
  assert.equal(c.maintenance?.note, "Earlier");
});

test("maintenance: listMaintenance lists current and upcoming, excludes past, filters", () => {
  const past = { checkId: "c2", start: 1, end: 50, note: "old" };
  const upcoming = { checkId: "c2", start: 300, end: 400, note: "later" };
  const upcoming2 = { checkId: "c1", start: 300, end: 400, note: "later too" };
  const { s, clock } = setup([upcoming, W, past, upcoming2]);
  clock.t = 150;
  assert.deepEqual(s.listMaintenance(), [W, upcoming2, upcoming]);
  assert.deepEqual(s.listMaintenance("c2"), [upcoming]);
  clock.t = 200; // end is exclusive
  assert.deepEqual(s.listMaintenance("c1"), [upcoming2]);
});

test("maintenance: GET /maintenance over HTTP", async () => {
  const { s, clock } = setup([W, { checkId: "c2", start: 300, end: 400, note: "n" }]);
  clock.t = 150;
  const server = createApiServer(s, { tokens: [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const all = await fetch(`${base}/maintenance`);
    assert.equal(all.status, 200);
    assert.equal(((await all.json()) as unknown[]).length, 2);
    const one = await fetch(`${base}/maintenance?checkId=c2`);
    assert.deepEqual(await one.json(), [{ checkId: "c2", start: 300, end: 400, note: "n" }]);
    assert.equal((await fetch(`${base}/maintenance`, { method: "POST" })).status, 405);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

function at(t: number, location: string, status: "up" | "down"): Result {
  return { ...res(t, status), location };
}

test("maintenance quorum: a down at end - 1 is excluded later, a down at end counts", () => {
  const { s } = setup();
  s.ingest(at(150, "a", "up"));
  s.ingest(at(199, "a", "down")); // inside [100, 200): never counts, also in later windows
  s.ingest(at(200, "b", "down")); // quorum window sees a up (199 excluded) and b down: not two downs
  assert.equal(s.listChecks()[0]!.state, "up");
  s.ingest(at(200, "a", "down")); // at end: outside the window, counts; a and b are down
  assert.equal(s.listChecks()[0]!.state, "down");
});

test("maintenance quorum: a late-arriving down inside a past window stays excluded", () => {
  const { s, clock } = setup();
  clock.t = 500; // the window is over when the results arrive
  s.ingest(at(150, "a", "up"));
  s.ingest(at(190, "a", "down"));
  s.ingest(at(195, "b", "down"));
  assert.equal(s.listChecks()[0]!.state, "up");
  assert.deepEqual(s.listIncidents(), []);
});
