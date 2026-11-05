import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  type InternalManualIncident,
  validateInternalManualIncident,
} from "@lorenzh/pulse-contract";
import { createAdminAuthFailures } from "./admin-auth-failures.ts";
import { openDb } from "./db.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { openTokenStore } from "./token-import.ts";

const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const clock = Date.parse("2030-01-10T12:00:00Z");
const db = openDb(":memory:");
const metrics = createMetrics();
const ignore = (): void => {
  // The auth failure lines are not under test here.
};
const server = createApiServer(createService(db, { now: () => clock }), {
  tokenStore: openTokenStore(
    { db, now: () => clock },
    { probe: undefined, admin: [{ name: "ops", token: ADMIN }] },
  ),
  isAdminEnabled: true,
  now: () => clock,
  metrics,
  adminAuthFailures: createAdminAuthFailures({ now: () => clock, warn: ignore, metrics }),
  manualIncidents: createManualIncidentStore(db, {
    now: () => clock,
    componentIds: () => new Set(["web"]),
    onEvent: (e) => metrics.recordManualIncident(e),
  }),
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ADMIN,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

function internal(json: unknown): InternalManualIncident {
  const v = validateInternalManualIncident(json);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
}

/** The `pulse_api_` lines of an anonymous scrape, without the scrape's own request lines. */
async function scrape(): Promise<{ all: string[]; stable: string[] }> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const all = text.split("\n").filter((l) => l.startsWith("pulse_api_"));
  const stable = all.filter(
    (l) => !(l.startsWith("pulse_api_http_requests_total") && l.includes('route="/metrics"')),
  );
  return { all, stable };
}

function lineOf(lines: string[], prefix: string): string | undefined {
  return lines.find((l) => l.startsWith(prefix));
}

const DRAFT = { title: "T", impact: "critical", componentIds: ["web"], message: "m" };

test("check 8: private-only activity leaves the anonymous metrics unchanged", async () => {
  const before = await scrape();
  assert.equal(
    lineOf(before.all, "pulse_api_manual_incidents_created_total "),
    "pulse_api_manual_incidents_created_total 0",
  );
  assert.equal(
    lineOf(before.all, "pulse_api_manual_incidents_resolved_total "),
    "pulse_api_manual_incidents_resolved_total 0",
  );

  const created = await call("POST", "/admin/manual-incidents", {
    ...DRAFT,
    visibility: "internal",
  });
  assert.equal(created.status, 201);
  const id = internal(created.json).id;
  assert.equal(
    (
      await call("PUT", `/admin/manual-incidents/${id}`, {
        ...DRAFT,
        title: "T2",
        visibility: "internal",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("POST", `/admin/manual-incidents/${id}/notes`, { message: "n" })).status,
    201,
  );
  assert.equal((await call("POST", `/admin/manual-incidents/${id}/publish`)).status, 200);
  assert.equal(
    (await call("PUT", `/admin/manual-incidents/${id}/draft`, { status: "resolved", message: "r" }))
      .status,
    200,
  );
  const resolved = await call("POST", `/admin/manual-incidents/${id}/publish`);
  assert.equal(resolved.status, 200);
  assert.equal(internal(resolved.json).status, "resolved");
  const control = await call("GET", `/admin/manual-incidents/${id}`);
  assert.equal(control.status, 200);
  assert.equal(internal(control.json).status, "resolved");

  const publicDraft = await call("POST", "/admin/manual-incidents", {
    ...DRAFT,
    visibility: "public",
  });
  const publicId = internal(publicDraft.json).id;
  const noted = await call("POST", `/admin/manual-incidents/${publicId}/notes`, { message: "n" });
  const noteId = internal(noted.json).notes[0]?.id;
  assert.equal(
    (await call("DELETE", `/admin/manual-incidents/${publicId}/notes/${noteId}`)).status,
    204,
  );
  assert.equal(
    (await call("POST", `/manual-incidents/${id}/updates`, { status: "identified", message: "x" }))
      .status,
    404,
  );

  const after = await scrape();
  assert.equal(
    lineOf(after.all, "pulse_api_manual_incidents_created_total "),
    "pulse_api_manual_incidents_created_total 0",
  );
  assert.equal(
    lineOf(after.all, "pulse_api_manual_incidents_resolved_total "),
    "pulse_api_manual_incidents_resolved_total 0",
  );
  assert.deepEqual(
    after.all.filter((l) => l.includes("/admin/manual-incidents")),
    [],
  );
  const legacy =
    'pulse_api_http_requests_total{route="/manual-incidents/:id/updates",code="404"} 1';
  assert.ok(after.stable.includes(legacy));
  assert.deepEqual(
    after.stable.filter((l) => l !== legacy),
    before.stable,
  );

  // Positive controls: a public publication and a public resolution count.
  assert.equal((await call("POST", `/admin/manual-incidents/${publicId}/publish`)).status, 200);
  assert.equal(
    lineOf((await scrape()).all, "pulse_api_manual_incidents_created_total "),
    "pulse_api_manual_incidents_created_total 1",
  );
  assert.equal((await call("POST", `/manual-incidents/${publicId}/resolve`)).status, 200);
  assert.equal(
    lineOf((await scrape()).all, "pulse_api_manual_incidents_resolved_total "),
    "pulse_api_manual_incidents_resolved_total 1",
  );

  // A failed auth is counted by route pattern; the request counter still never names the path.
  assert.equal((await call("GET", "/admin/manual-incidents/1", undefined, null)).status, 401);
  assert.equal(
    (await call("GET", "/admin/manual-incidents/abc/x/y/z", undefined, null)).status,
    404,
  );
  const last = await scrape();
  assert.deepEqual(
    last.all.filter((l) => l.includes("/admin/manual-incidents")),
    ['pulse_api_admin_auth_failures_total{route="/admin/manual-incidents/:id",status="401"} 1'],
  );
  assert.equal(
    lineOf(last.all, 'pulse_api_http_requests_total{route="unmatched"'),
    lineOf(before.all, 'pulse_api_http_requests_total{route="unmatched"'),
  );
});
