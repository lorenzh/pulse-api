import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  type Component,
  type ErrorResponse,
  MANUAL_INCIDENT_MAX_UPDATES,
  type ManualIncident,
  type ManualIncidentsResponse,
  validateManualIncident,
  validateManualIncidentsResponse,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const ADMIN = "admin-token-0123456789abcdef";
const PROBE = "probe-token-0123456789abcdef";
const DAY = 86_400_000;
let clock = Date.parse("2030-01-10T12:00:00Z");
const components: Component[] = [{ id: "web", name: "Web", checkIds: [] }];

function setup(isAdminOn: boolean) {
  const db = openDb(":memory:");
  const service = createService(db, { now: () => clock });
  const metrics = createMetrics();
  const store = createManualIncidentStore(db, {
    now: () => clock,
    componentIds: new Set(components.map((c) => c.id)),
    onEvent: (e) => metrics.recordManualIncident(e),
  });
  const server = createApiServer(service, {
    tokens: [{ location: "eu", token: PROBE }],
    now: () => clock,
    components,
    metrics,
    manualIncidents: store,
    ...(isAdminOn ? { adminTokens: [ADMIN] } : {}),
  });
  return { server, metrics, db };
}

const on = setup(true);
const off = setup(false);
let base = "";
let offBase = "";
beforeAll(async () => {
  for (const s of [on.server, off.server]) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  }
  base = `http://127.0.0.1:${(on.server.address() as AddressInfo).port}`;
  offBase = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [on.server, off.server]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
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
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

function incident(json: unknown): ManualIncident {
  const v = validateManualIncident(json);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
}

function errorOf(json: unknown): string {
  return (json as ErrorResponse).error;
}

const NEW = { title: "DB slow", impact: "minor", componentIds: ["web"], message: "Looking." };

test("create, update, resolve: reads list it in time order and metrics count once", async () => {
  const created = await call("POST", "/manual-incidents", NEW);
  assert.equal(created.status, 201);
  const first = incident(created.json);
  assert.equal(first.status, "investigating");
  assert.equal(first.resolvedAt, null);
  assert.deepEqual(first.updates, [{ at: clock, status: "investigating", message: "Looking." }]);

  clock += 1000;
  const updated = await call("POST", `/manual-incidents/${first.id}/updates`, {
    status: "identified",
    message: "Found it.",
  });
  assert.equal(updated.status, 201);
  assert.equal(incident(updated.json).updates.length, 2);

  clock += 1000;
  const resolved = await call("POST", `/manual-incidents/${first.id}/updates`, {
    status: "resolved",
    message: "Fixed.",
  });
  const done = incident(resolved.json);
  assert.equal(done.status, "resolved");
  assert.equal(done.resolvedAt, clock);
  assert.deepEqual(
    done.updates.map((u) => u.message),
    ["Looking.", "Found it.", "Fixed."],
  );

  const list = await call("GET", "/manual-incidents", undefined, null);
  const parsed = validateManualIncidentsResponse(list.json);
  assert.ok(parsed.ok);
  assert.deepEqual(
    (list.json as ManualIncidentsResponse).map((i) => i.id),
    [first.id],
  );
  const one = await call("GET", `/manual-incidents/${first.id}`, undefined, null);
  assert.equal(incident(one.json).id, first.id);

  const metrics = on.metrics.render();
  assert.match(metrics, /^pulse_api_manual_incidents_created_total 1$/m);
  assert.match(metrics, /^pulse_api_manual_incidents_resolved_total 1$/m);
  assert.match(metrics, /route="\/manual-incidents\/:id\/updates"/);

  const gone = await call("DELETE", `/manual-incidents/${first.id}`);
  assert.equal(gone.status, 204);
  assert.deepEqual((await call("GET", "/manual-incidents", undefined, null)).json, []);
  assert.equal((await call("GET", `/manual-incidents/${first.id}`, undefined, null)).status, 404);
  assert.equal((await call("DELETE", `/manual-incidents/${first.id}`)).status, 404);
});

test("a resolved incident takes no update, no second resolve; status filter and recent window", async () => {
  const open = incident((await call("POST", "/manual-incidents", NEW)).json);
  const old = incident(
    (await call("POST", "/manual-incidents", { ...NEW, componentIds: [], status: "monitoring" }))
      .json,
  );
  const resolved = await call("POST", `/manual-incidents/${old.id}/resolve`);
  assert.equal(incident(resolved.json).updates.at(-1)?.message, "Resolved.");
  const again = await call("POST", `/manual-incidents/${old.id}/resolve`, { message: "x" });
  assert.equal(again.status, 409);
  const reopen = await call("POST", `/manual-incidents/${old.id}/updates`, {
    status: "investigating",
    message: "again",
  });
  assert.equal(reopen.status, 409);

  const ids = async (q: string): Promise<number[]> =>
    ((await call("GET", `/manual-incidents${q}`, undefined, null)).json as ManualIncident[]).map(
      (i) => i.id,
    );
  assert.deepEqual(await ids("?status=open"), [open.id]);
  assert.deepEqual(await ids("?status=resolved"), [old.id]);
  assert.deepEqual(await ids(""), [open.id, old.id]);
  assert.equal((await call("GET", "/manual-incidents?status=bogus", undefined, null)).status, 400);

  clock += 15 * DAY;
  assert.deepEqual(await ids("?status=resolved"), []);
  await call("DELETE", `/manual-incidents/${open.id}`);
  await call("DELETE", `/manual-incidents/${old.id}`);
});

test("resolve with a message, and resolve errors", async () => {
  const i = incident((await call("POST", "/manual-incidents", NEW)).json);
  assert.equal(
    (await call("POST", `/manual-incidents/${i.id}/resolve`, { message: "" })).status,
    400,
  );
  assert.equal((await call("POST", `/manual-incidents/${i.id}/resolve`, [1])).status, 400);
  assert.equal((await call("POST", `/manual-incidents/${i.id}/resolve`, "{bad")).status, 400);
  const ok = await call("POST", `/manual-incidents/${i.id}/resolve`, { message: "All good." });
  assert.equal(incident(ok.json).updates.at(-1)?.message, "All good.");
  assert.equal((await call("POST", "/manual-incidents/999/resolve")).status, 404);
  await call("DELETE", `/manual-incidents/${i.id}`);
});

test("writes need an admin token: none, probe and wrong tokens are refused", async () => {
  for (const token of [null, PROBE, "wrong-token-0123456789abcdef"]) {
    const r = await call("POST", "/manual-incidents", NEW, token);
    assert.equal(r.status, 401);
    assert.equal(errorOf(r.json), "unauthorized");
    assert.equal((await call("DELETE", "/manual-incidents/1", undefined, token)).status, 401);
    assert.equal((await call("POST", "/manual-incidents/1/resolve", undefined, token)).status, 401);
  }
  assert.deepEqual((await call("GET", "/manual-incidents", undefined, null)).json, []);
});

test("an admin token does not authenticate probe routes", async () => {
  const r = await call("POST", "/results", { checkId: "x" }, ADMIN);
  assert.equal(r.status, 401);
});

test("input is rejected: unknown component, long text, control characters, bad status", async () => {
  const bad = async (patch: Record<string, unknown>, status = 400): Promise<string> => {
    const r = await call("POST", "/manual-incidents", { ...NEW, ...patch });
    assert.equal(r.status, status, JSON.stringify(patch));
    return errorOf(r.json);
  };
  assert.match(await bad({ componentIds: ["nope"] }), /unknown component "nope"/);
  await bad({ title: "x".repeat(201) });
  await bad({ title: "" });
  await bad({ title: "a\u0000b" });
  await bad({ message: "m".repeat(2001) });
  await bad({ message: "" });
  await bad({ impact: "huge" });
  await bad({ status: "resolved" });
  await bad({ componentIds: ["web", "web"] });
  assert.equal((await call("POST", "/manual-incidents", "[]")).status, 400);
  assert.equal((await call("POST", "/manual-incidents", "not json")).status, 400);
  const big = await call("POST", "/manual-incidents", { ...NEW, message: "m".repeat(20_000) });
  assert.equal(big.status, 413);
  const r = await call("POST", "/manual-incidents", { ...NEW, message: "line1\nline2" });
  assert.equal(r.status, 201);
  await call("DELETE", `/manual-incidents/${incident(r.json).id}`);
});

test("HTML text is stored as written and not changed", async () => {
  const text = "<script>alert(1)</script>";
  const r = await call("POST", "/manual-incidents", { ...NEW, title: text, message: text });
  const i = incident(r.json);
  assert.equal(i.title, text);
  assert.equal(i.updates[0]?.message, text);
  await call("DELETE", `/manual-incidents/${i.id}`);
});

test("an incident takes at most 100 updates", async () => {
  const i = incident((await call("POST", "/manual-incidents", NEW)).json);
  for (let n = 1; n < MANUAL_INCIDENT_MAX_UPDATES; n++) {
    const r = await call("POST", `/manual-incidents/${i.id}/updates`, {
      status: "monitoring",
      message: `u${n}`,
    });
    assert.equal(r.status, 201);
  }
  const over = await call("POST", `/manual-incidents/${i.id}/updates`, {
    status: "monitoring",
    message: "one too many",
  });
  assert.equal(over.status, 409);
  await call("DELETE", `/manual-incidents/${i.id}`);
});

test("update times never go backwards when the clock does", async () => {
  const i = incident((await call("POST", "/manual-incidents", NEW)).json);
  clock -= 5000;
  const u = incident(
    (
      await call("POST", `/manual-incidents/${i.id}/updates`, {
        status: "identified",
        message: "m",
      })
    ).json,
  );
  assert.equal(u.updates[1]?.at, i.updates[0]?.at);
  clock += 5000;
  await call("DELETE", `/manual-incidents/${i.id}`);
});

test("without admin tokens the writes answer 404 and reads are empty", async () => {
  const w = await call("POST", "/manual-incidents", NEW, ADMIN, offBase);
  assert.equal(w.status, 404);
  assert.equal(
    (await call("DELETE", "/manual-incidents/1", undefined, ADMIN, offBase)).status,
    404,
  );
  assert.equal(
    (await call("POST", "/manual-incidents/1/resolve", undefined, ADMIN, offBase)).status,
    404,
  );
  const list = await call("GET", "/manual-incidents", undefined, null, offBase);
  assert.deepEqual(list.json, []);
});

test("unknown ids, bad ids, and wrong methods", async () => {
  assert.equal((await call("GET", "/manual-incidents/abc", undefined, null)).status, 404);
  assert.equal((await call("GET", "/manual-incidents/1/updates", undefined, null)).status, 405);
  assert.equal((await call("PUT", "/manual-incidents")).status, 405);
  assert.equal((await call("POST", "/manual-incidents/1")).status, 405);
  assert.equal(
    (await call("POST", "/manual-incidents/999/updates", { status: "identified", message: "m" }))
      .status,
    404,
  );
});

test("server without a store answers an empty list and 404 for writes with tokens", async () => {
  const db = openDb(":memory:");
  const server = createApiServer(createService(db, {}), { tokens: [], adminTokens: [ADMIN] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual((await call("GET", "/manual-incidents", undefined, null, url)).json, []);
    assert.equal((await call("POST", "/manual-incidents", NEW, ADMIN, url)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
