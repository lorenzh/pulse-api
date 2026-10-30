import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
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
  const server = createApiServer(service, { tokens: [] });
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
