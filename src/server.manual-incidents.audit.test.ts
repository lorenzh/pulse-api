import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ManualIncident } from "@lorenzh/pulse-contract";
import { createAdminAuthFailures } from "./admin-auth-failures.ts";
import { openDb } from "./db.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const ADMIN = "admin-sentinel-0123456789abcdef";
const PROBE = "probe-sentinel-0123456789abcdef";
const UNKNOWN = "not-a-real-token-123456";
const TITLE = "title-sentinel";
const MESSAGE = "message-sentinel";

type Line = { level: "info" | "warn"; message: string; fields: Record<string, string> };
const lines: Line[] = [];
let clock = Date.parse("2030-01-10T12:00:00Z");

function setup(isAdminOn: boolean) {
  const db = openDb(":memory:");
  const metrics = createMetrics();
  const store = createManualIncidentStore(db, {
    now: () => clock,
    componentIds: () => new Set(["web"]),
  });
  const warn = (message: string, fields: Record<string, string>) =>
    lines.push({ level: "warn", message, fields });
  return {
    metrics,
    server: createApiServer(createService(db, { now: () => clock }), {
      tokens: [{ location: "default", token: PROBE }],
      now: () => clock,
      metrics,
      manualIncidents: store,
      ...(isAdminOn ? { adminTokens: [{ name: "ops", token: ADMIN }] } : {}),
      // A new clock value per failure keeps every line out of the rate limit.
      adminAuthFailures: createAdminAuthFailures({ now: () => clock, warn, metrics }),
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warn,
    }),
  };
}

const on = setup(true);
const off = setup(false);
let base = "";
let offBase = "";
beforeAll(async () => {
  for (const s of [on.server, off.server])
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(on.server.address() as AddressInfo).port}`;
  offBase = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [on.server, off.server]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
beforeEach(() => {
  lines.length = 0;
  clock += 10 * 60_000;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ADMIN,
  host = base,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

const NEW = { title: TITLE, impact: "minor", componentIds: ["web"], message: MESSAGE };

function assertNoSecrets(): void {
  const text = JSON.stringify(lines);
  for (const secret of [ADMIN, PROBE, UNKNOWN, TITLE, MESSAGE]) {
    assert.equal(text.includes(secret), false, secret);
  }
}

test("each successful write logs one info line with the token name, action and id", async () => {
  const created = await call("POST", "/manual-incidents", NEW);
  assert.equal(created.status, 201);
  const id = String((created.json as ManualIncident).id);
  assert.equal(
    (
      await call("POST", `/manual-incidents/${id}/updates`, {
        status: "identified",
        message: MESSAGE,
      })
    ).status,
    201,
  );
  assert.equal((await call("POST", `/manual-incidents/${id}/resolve`)).status, 200);
  assert.equal((await call("DELETE", `/manual-incidents/${id}`)).status, 204);
  assert.deepEqual(
    lines,
    ["create", "update", "resolve", "delete"].map((action) => ({
      level: "info",
      message: "manual incident write",
      fields: { token: "ops", action, id },
    })),
  );
  assertNoSecrets();
});

test("a write that fails after auth logs one warn line and no info line", async () => {
  assert.equal((await call("POST", "/manual-incidents/999/resolve")).status, 404);
  assert.equal((await call("POST", "/manual-incidents", { ...NEW, impact: "huge" })).status, 400);
  assert.deepEqual(lines, [
    {
      level: "warn",
      message: "manual incident write failed",
      fields: { status: "404", action: "resolve", id: "999" },
    },
    {
      level: "warn",
      message: "manual incident write failed",
      fields: { status: "400", action: "create" },
    },
  ]);
  assertNoSecrets();
});

test("a 405 is decided before auth and logs nothing", async () => {
  assert.equal((await call("PUT", "/manual-incidents/1")).status, 405);
  assert.deepEqual(lines, []);
});

test("failed authentication answers 401 and logs the token kind, never the token", async () => {
  const cases: [string | null, string][] = [
    [null, "missing"],
    [PROBE, "probe"],
    [UNKNOWN, "unknown"],
  ];
  for (const [token, kind] of cases) {
    lines.length = 0;
    clock += 10 * 60_000;
    const r = await call("POST", "/manual-incidents", NEW, token);
    assert.equal(r.status, 401);
    assert.deepEqual(lines, [
      {
        level: "warn",
        message: "admin auth failed",
        fields: { route: "/manual-incidents", status: "401", token: kind, suppressed: "0" },
      },
    ]);
  }
  clock += 10 * 60_000;
  await call("POST", "/manual-incidents/999999999999999/resolve", undefined, null);
  assert.equal(lines.at(-1)?.fields.route, "/manual-incidents/:id/resolve");
  assertNoSecrets();
  assert.match(
    on.metrics.render(),
    /pulse_api_admin_auth_failures_total\{route="\/manual-incidents",status="401"\} 3\n/,
  );
});

test("with the feature off a write answers 404 and logs nothing", async () => {
  const r = await call("POST", "/manual-incidents", NEW, null, offBase);
  assert.equal(r.status, 404);
  assert.deepEqual(lines, []);
  assert.doesNotMatch(off.metrics.render(), /pulse_api_admin_auth_failures_total\{/);
});
