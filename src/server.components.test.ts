import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  type Component,
  type ComponentsResponse,
  type ComponentsUptimeResponse,
  validateComponentsResponse,
  validateComponentsUptimeResponse,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService, UPTIME_DAYS } from "./service.ts";

const NOW = Date.parse("2030-01-10T12:00:00Z");
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const check = (id: string) => ({ id, name: id, url: "http://x/", intervalMs: 1000 });
const components: Component[] = [
  { id: "web", name: "Web", group: "Services", checkIds: ["a", "b"] },
  { id: "api", name: "API", checkIds: ["b", "c"] },
  { id: "quiet", name: "Quiet", checkIds: ["d"] },
];

function start(list: readonly Component[]) {
  const db = openDb(":memory:");
  const service = createService(db, {
    now: () => NOW,
    maintenance: [{ checkId: "c", start: NOW - 1000, end: NOW + 1000, note: "n" }],
  });
  service.upsertChecks(["a", "b", "c", "d"].map(check));
  const result = (checkId: string, status: "up" | "down" | "degraded", t: number) =>
    service.ingest({
      checkId,
      timestamp: t,
      status,
      statusCode: null,
      latencyMs: 1,
      reason: null,
      location: "default",
      attempts: 1,
    });
  result("a", "up", NOW - 10);
  result("b", "up", NOW - 60);
  for (const t of [50, 40, 30]) result("b", "down", NOW - t);
  const server = createApiServer(service, { tokens: [], now: () => NOW, components: list });
  return { server };
}

const running = start(components);
const empty = start([]);
let base = "";
let emptyBase = "";
beforeAll(async () => {
  for (const s of [running.server, empty.server]) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  }
  base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  emptyBase = `http://127.0.0.1:${(empty.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [running.server, empty.server]) {
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  }
});

test("GET /components: states, uptime and open incident ids in configured order", async () => {
  const body: unknown = await (await fetch(`${base}/components`)).json();
  const verdict = validateComponentsResponse(body);
  assert.ok(verdict.ok, verdict.ok ? "" : verdict.error);
  const list = body as ComponentsResponse;
  assert.deepEqual(
    list.map((c) => [c.id, c.state, c.incidentIds.length]),
    [
      ["web", "down", 1],
      ["api", "down", 1],
      ["quiet", "unknown", 0],
    ],
  );
  assert.equal(list[2]?.uptime, null);
  assert.equal(list[0]?.group, "Services");
  assert.deepEqual(list[0]?.incidentIds, list[1]?.incidentIds);
});

test("GET /components/uptime: 90 days per component, equal to the window value", async () => {
  const body: unknown = await (await fetch(`${base}/components/uptime`)).json();
  const verdict = validateComponentsUptimeResponse(body);
  assert.ok(verdict.ok, verdict.ok ? "" : verdict.error);
  const list = body as ComponentsUptimeResponse;
  assert.deepEqual(
    list.map((c) => c.componentId),
    ["web", "api", "quiet"],
  );
  assert.equal(list[0]?.days.length, UPTIME_DAYS);
  const states = (await (await fetch(`${base}/components`)).json()) as ComponentsResponse;
  assert.deepEqual(
    list.map((c) => c.uptime),
    states.map((c) => c.uptime),
  );
});

test("components routes answer [] without components and refuse other methods", async () => {
  assert.deepEqual(await (await fetch(`${emptyBase}/components`)).json(), []);
  assert.deepEqual(await (await fetch(`${emptyBase}/components/uptime`)).json(), []);
  assert.equal((await fetch(`${base}/components`, { method: "POST" })).status, 405);
});
