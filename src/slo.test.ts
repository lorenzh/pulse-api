import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Check,
  CheckLatency,
  CheckWithState,
  ComponentWithState,
} from "@lorenzh/pulse-contract";
import { validateSlo } from "@lorenzh/pulse-contract";
import { componentsWithState } from "./components.ts";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import { createService } from "./service.ts";
import { buildSlo } from "./slo.ts";
import { type StartDeps, startApi } from "./start.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const TODAY = Date.parse("2026-10-28T00:00:00Z");

const CHECKS: Check[] = [
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
  { id: "a", name: "A", url: "http://a/", intervalMs: 60_000 },
  { id: "hb", name: "HB", type: "heartbeat", period: 60_000, grace: 1000 },
];

function setup(targets: Record<string, number>) {
  const db = openDb(":memory:");
  const service = createService(db, {
    now: () => NOW,
    availabilityTargets: () => new Map(Object.entries(targets)),
  });
  service.upsertChecks(CHECKS);
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES (?, ?, ?, 1, 'default')",
  );
  const add = (t: number, status: string, n: number, id = "a") => {
    for (let i = 0; i < n; i++) insert.run(id, t + i + (status === "up" ? 0 : 100_000), status);
  };
  return { service, add };
}

test("buildSlo: 99.95 against 99.9 leaves 50, 99.8 leaves -100, no data is null", () => {
  assert.ok(Math.abs((buildSlo(99.9, 99.95).budgetRemaining ?? 0) - 50) < 1e-9);
  assert.ok(Math.abs((buildSlo(99.9, 99.8).budgetRemaining ?? 0) + 100) < 1e-9);
  assert.deepEqual(buildSlo(99.9, null), {
    target: 99.9,
    windowDays: 30,
    availability: null,
    budgetRemaining: null,
  });
  assert.equal(validateSlo(buildSlo(99.9, 100)).ok, true);
});

test("slo on a check: 30 days, degraded is up, down is not, older days are outside", () => {
  const { service, add } = setup({ a: 99.9 });
  add(TODAY - 29 * DAY + 1000, "up", 1000);
  add(TODAY - 10 * DAY + 1000, "degraded", 999);
  add(TODAY + 1000, "down", 1);
  // Day 30 back is outside the window.
  add(TODAY - 30 * DAY + 1000, "down", 5000);
  const a = service.listChecks().find((c) => c.id === "a");
  assert.ok(a?.slo);
  assert.equal(a.slo.target, 99.9);
  assert.equal(a.slo.windowDays, 30);
  assert.ok(Math.abs((a.slo.availability ?? 0) - 99.95) < 1e-9);
  assert.ok(Math.abs((a.slo.budgetRemaining ?? 0) - 50) < 1e-9);
});

test("slo: only checks with a target carry it, a target without results is null, heartbeat is allowed", () => {
  const { service } = setup({ hb: 99 });
  const [a, hb] = service.listChecks() as CheckWithState[];
  assert.equal(a?.slo, undefined);
  assert.deepEqual(hb?.slo, {
    target: 99,
    windowDays: 30,
    availability: null,
    budgetRemaining: null,
  });
});

test("slo on a component merges its checks result-weighted", () => {
  const { service, add } = setup({});
  add(TODAY - DAY + 1000, "up", 1998, "a");
  add(TODAY - DAY + 1000, "down", 2, "a");
  const components = [
    { id: "web", name: "Web", checkIds: ["a", "hb"], availabilityTarget: 99.9 },
    { id: "plain", name: "Plain", checkIds: ["a"] },
    { id: "empty", name: "Empty", checkIds: ["hb"], availabilityTarget: 99 },
  ];
  const states = service.listCheckStates();
  const [web, plain, empty] = componentsWithState(
    components,
    states,
    service.getUptime(),
    [],
    service.getSloDays,
  ) as ComponentWithState[];
  assert.ok(Math.abs((web?.slo?.availability ?? 0) - 99.9) < 1e-9);
  assert.ok(Math.abs(web?.slo?.budgetRemaining ?? 1) < 1e-9);
  assert.equal(plain?.slo, undefined);
  assert.equal(empty?.slo?.availability, null);
});

test("metric: the budget is a ratio per check and component, omitted when null", () => {
  const metrics = createMetrics({
    listBudgets: () => ({
      checks: [
        { id: "a", budgetRemaining: 50 },
        { id: "b", budgetRemaining: -100 },
      ],
      components: [{ id: "web", budgetRemaining: 25 }],
    }),
  });
  const text = metrics.render();
  assert.match(text, /pulse_api_slo_budget_remaining_ratio\{check="a"\} 0\.5\n/);
  assert.match(text, /pulse_api_slo_budget_remaining_ratio\{check="b"\} -1\n/);
  assert.match(text, /pulse_api_slo_budget_remaining_ratio\{component="web"\} 0\.25\n/);
  const none = createMetrics().render();
  assert.doesNotMatch(none, /pulse_api_slo_budget_remaining_ratio\{/);
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-slo-"));
  writeFileSync(
    join(dir, "checks.json"),
    JSON.stringify({
      checks: [
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
        { id: "a", name: "A", url: "http://a/", intervalMs: 60_000, availabilityTarget: 99.9 },
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
        { id: "b", name: "B", url: "http://b/", intervalMs: 60_000 },
        {
          id: "t",
          name: "T",
          type: "tcp",
          host: "x",
          port: 1,
          intervalMs: 60_000,
          availabilityTarget: 99,
        },
      ],
      components: [{ id: "web", name: "Web", checkIds: ["a", "b"], availabilityTarget: 99.9 }],
    }),
  );
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: "test-token-east-0123456789abcdef" }] }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("end to end: slo, latency and the gauge over HTTP; the probe listing carries no target", async () => {
  const lines: string[] = [];
  const base: StartDeps = {
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "t.db"),
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
    },
    now: () => NOW,
    sleep: () => Promise.resolve(),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => lines.push(line),
    openDb: (path) => openDb(path),
  };
  const api = await startApi(base);
  const url = `http://127.0.0.1:${api.port}`;
  try {
    for (const [i, latencyMs] of [100, 200, 300].entries()) {
      const res = await fetch(`${url}/results`, {
        method: "POST",
        headers: { authorization: "Bearer test-token-east-0123456789abcdef" },
        body: JSON.stringify({
          checkId: "a",
          timestamp: NOW - i * 1000,
          status: "up",
          statusCode: 200,
          latencyMs,
          reason: null,
          attempts: 1,
        }),
      });
      assert.equal(res.status, 204);
    }
    const checks = (await (await fetch(`${url}/checks`)).json()) as CheckWithState[];
    assert.deepEqual(checks.find((c) => c.id === "a")?.slo, {
      target: 99.9,
      windowDays: 30,
      availability: 100,
      budgetRemaining: 100,
    });
    assert.equal(checks.find((c) => c.id === "b")?.slo, undefined);
    assert.equal(checks.find((c) => c.id === "t")?.slo?.availability, null);
    const components = (await (await fetch(`${url}/components`)).json()) as ComponentWithState[];
    assert.equal(components[0]?.slo?.budgetRemaining, 100);
    const latency = (await (await fetch(`${url}/checks/a/latency`)).json()) as CheckLatency;
    assert.deepEqual(latency.days[89], { date: "2026-10-28", p50Ms: 200, p95Ms: 300, count: 3 });
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.match(metrics, /pulse_api_slo_budget_remaining_ratio\{check="a"\} 1\n/);
    assert.match(metrics, /pulse_api_slo_budget_remaining_ratio\{component="web"\} 1\n/);
    assert.doesNotMatch(metrics, /slo_budget_remaining_ratio\{check="t"\}/);
    const probe = await fetch(`${url}/probe/checks`, {
      headers: { authorization: "Bearer test-token-east-0123456789abcdef" },
    });
    const listing = (await probe.json()) as Record<string, unknown>[];
    assert.equal(listing.length, 3);
    for (const check of listing) {
      assert.equal("availabilityTarget" in check, false);
      assert.equal("slo" in check, false);
    }
  } finally {
    await api.close();
  }
});

test("a late result for a closed day is counted at the next read, also from the day cache", () => {
  let t = NOW;
  const db = openDb(":memory:");
  const service = createService(db, { now: () => t });
  service.upsertChecks(CHECKS);
  const post = (at: number, status: "up" | "down", location: string) =>
    service.ingest({
      checkId: "a",
      timestamp: at,
      status,
      statusCode: null,
      latencyMs: 1,
      reason: null,
      location,
      attempts: 1,
    });
  post(TODAY - DAY + 1000, "up", "eu");
  assert.equal(service.getUptime()[0]?.days[88]?.results, 1);
  t += 10_000;
  post(TODAY - DAY + 500, "down", "us");
  assert.equal(service.getUptime()[0]?.days[88]?.results, 2);
  assert.equal(service.getUptime()[0]?.days[88]?.uptime, 50);
  // A new day moves today into the closed days.
  t += DAY;
  assert.equal(service.getUptime()[0]?.days[87]?.results, 2);
});
