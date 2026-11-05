import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InternalManualIncident,
  MANUAL_INCIDENT_MAX_BODY_BYTES,
  type ManualIncident,
  validateInternalManualIncident,
  validateInternalManualIncidentsResponse,
  validateManualIncident,
  validateManualIncidentsResponse,
} from "@lorenzh/pulse-contract";
import type { AdminAuthThrottle } from "./admin-auth-throttle.ts";
import { openDb } from "./db.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { MIGRATIONS } from "./migrations.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { openTokenStore } from "./token-import.ts";

const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const PROBE = "probe-token-0123456789abcdef";
const UNKNOWN_BODY = '{"error":"manual incident not found"}';
const dir = mkdtempSync(join(tmpdir(), "pulse-private-"));
let clock = Date.parse("2030-01-10T12:00:00Z");
const servers: Server[] = [];

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(dir, { recursive: true, force: true });
});

type ApiOptions = {
  path?: string;
  isAdminOn?: boolean;
  throttle?: AdminAuthThrottle;
};

type Api = {
  base: string;
  components: Set<string>;
  configToken: string;
  close: () => Promise<void>;
};

let fileCount = 0;

async function startApi(options: ApiOptions = {}): Promise<Api> {
  const path = options.path ?? join(dir, `api-${fileCount++}.db`);
  const isAdminOn = options.isAdminOn ?? true;
  // A reopened file already holds the imported tokens.
  const isReopen = existsSync(path);
  const db = openDb(path);
  const components = new Set(["web"]);
  const metrics = createMetrics();
  const tokens = openTokenStore(
    { db, now: () => clock },
    isReopen
      ? { probe: undefined, admin: undefined }
      : {
          probe: [{ location: "eu", token: PROBE }],
          admin: isAdminOn ? [{ name: "ops", token: ADMIN }] : undefined,
        },
  );
  const configToken =
    isAdminOn && !isReopen
      ? tokens.create(
          {
            name: "cfg",
            scopes: ["admin", "checks"],
            location: null,
            expiresAt: null,
            source: "api",
          },
          { tokenId: "test", name: "test" },
        ).secret
      : "";
  const store = createManualIncidentStore(db, {
    now: () => clock,
    componentIds: () => components,
    onEvent: (e) => metrics.recordManualIncident(e),
  });
  // No `admin` handler: the config writes are off, the private routes must still answer.
  const server = createApiServer(createService(db, { now: () => clock }), {
    tokenStore: tokens,
    isAdminEnabled: isAdminOn,
    now: () => clock,
    metrics,
    manualIncidents: store,
    ...(options.throttle === undefined ? {} : { adminAuthThrottle: options.throttle }),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    servers.splice(servers.indexOf(server), 1);
    db.close();
  };
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, components, configToken, close };
}

type Reply = { status: number; text: string; json: unknown; headers: Headers };

async function call(
  api: Api,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ADMIN,
): Promise<Reply> {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: text === "" ? undefined : JSON.parse(text),
    headers: res.headers,
  };
}

function internal(reply: Reply): InternalManualIncident {
  const v = validateInternalManualIncident(reply.json);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
}

function publicOne(reply: Reply): ManualIncident {
  const v = validateManualIncident(reply.json);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
}

async function publicList(api: Api, status = "all"): Promise<ManualIncident[]> {
  const reply = await call(api, "GET", `/manual-incidents?status=${status}`, undefined, null);
  assert.equal(reply.status, 200);
  const v = validateManualIncidentsResponse(reply.json);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
}

function errorOf(reply: Reply): string {
  return (reply.json as { error: string }).error;
}

const DRAFT = {
  title: "DB slow",
  impact: "minor",
  componentIds: ["web"],
  message: "Looking.",
  visibility: "public",
};

async function createDraft(api: Api, body: Record<string, unknown> = DRAFT): Promise<number> {
  const created = await call(api, "POST", "/admin/manual-incidents", body);
  assert.equal(created.status, 201, created.text);
  return internal(created).id;
}

async function published(api: Api, body: Record<string, unknown> = DRAFT): Promise<number> {
  const id = await createDraft(api, body);
  const reply = await call(api, "POST", `/admin/manual-incidents/${id}/publish`);
  assert.equal(reply.status, 200, reply.text);
  return id;
}

async function metricValue(api: Api, name: string): Promise<number> {
  const text = await (await fetch(`${api.base}/metrics`)).text();
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  return Number(line?.split(" ")[1]);
}

test("check 1-2: a draft is private until published, then public at publication time", async () => {
  const api = await startApi();
  const created = await call(api, "POST", "/admin/manual-incidents", DRAFT);
  assert.equal(created.status, 201);
  const draft = internal(created);
  assert.equal(draft.publishedAt, null);
  const saved = clock;

  const read = await call(api, "GET", `/admin/manual-incidents/${draft.id}`);
  assert.equal(read.status, 200);
  assert.equal(internal(read).title, "DB slow");
  assert.deepEqual(await publicList(api, "all"), []);
  assert.deepEqual(await publicList(api, "open"), []);
  const detail = await call(api, "GET", `/manual-incidents/${draft.id}`, undefined, null);
  assert.equal(detail.status, 404);
  assert.equal(detail.text, UNKNOWN_BODY);

  clock += 60_000;
  const first = await call(api, "POST", `/admin/manual-incidents/${draft.id}/publish`);
  assert.equal(first.status, 200);
  assert.equal(internal(first).publishedAt, saved + 60_000);
  assert.equal(internal(first).createdAt, saved);
  const [listed] = await publicList(api, "all");
  assert.equal(listed?.id, draft.id);
  assert.equal(listed?.createdAt, saved + 60_000);
  assert.equal(listed?.updates[0]?.at, saved + 60_000);

  const second = await call(api, "POST", `/admin/manual-incidents/${draft.id}/publish`);
  assert.equal(second.status, 409);
  assert.equal(errorOf(second), "manual incident has no draft");
  assert.equal((await publicList(api, "all"))[0]?.updates.length, 1);
  await api.close();
});

test("check 3: a resolving draft update changes nothing public until it is published", async () => {
  const api = await startApi();
  const id = await published(api);
  const before = await call(api, "GET", `/manual-incidents/${id}`, undefined, null);
  const resolvedBefore = await metricValue(api, "pulse_api_manual_incidents_resolved_total");

  clock += 1000;
  const saved = await call(api, "PUT", `/admin/manual-incidents/${id}/draft`, {
    status: "resolved",
    message: "U-sentinel",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(internal(saved).draft, {
    status: "resolved",
    message: "U-sentinel",
    savedAt: clock,
  });
  const during = await call(api, "GET", `/manual-incidents/${id}`, undefined, null);
  assert.equal(during.text, before.text);
  assert.equal(publicOne(during).resolvedAt, null);
  assert.ok(!JSON.stringify(await publicList(api)).includes("U-sentinel"));

  clock += 1000;
  assert.equal((await call(api, "POST", `/admin/manual-incidents/${id}/publish`)).status, 200);
  const after = publicOne(await call(api, "GET", `/manual-incidents/${id}`, undefined, null));
  assert.equal(after.status, "resolved");
  assert.equal(after.resolvedAt, clock);
  assert.equal(after.updates.length, 2);
  assert.equal(after.updates[1]?.at, clock);
  assert.equal(
    await metricValue(api, "pulse_api_manual_incidents_resolved_total"),
    resolvedBefore + 1,
  );
  await api.close();
});

test("check 4: notes and draft updates survive a reopen and never reach public bytes", async () => {
  const path = join(dir, "reopen.db");
  let api = await startApi({ path });
  const id = await published(api);
  const before = publicOne(await call(api, "GET", `/manual-incidents/${id}`, undefined, null));
  clock += 1000;
  const note = await call(api, "POST", `/admin/manual-incidents/${id}/notes`, {
    message: "N-sentinel",
  });
  assert.equal(note.status, 201);
  assert.equal(
    (
      await call(api, "PUT", `/admin/manual-incidents/${id}/draft`, {
        status: "monitoring",
        message: "D-sentinel",
      })
    ).status,
    200,
  );
  await api.close();

  api = await startApi({ path });
  const read = internal(await call(api, "GET", `/admin/manual-incidents/${id}`));
  assert.deepEqual(read.notes, [
    { id: read.notes[0]?.id ?? 0, at: clock, author: "ops", message: "N-sentinel" },
  ]);
  assert.equal(read.draft?.message, "D-sentinel");
  const detail = await call(api, "GET", `/manual-incidents/${id}`, undefined, null);
  const list = await call(api, "GET", "/manual-incidents", undefined, null);
  for (const text of [detail.text, list.text]) {
    assert.ok(!text.includes("N-sentinel"));
    assert.ok(!text.includes("D-sentinel"));
  }
  assert.deepEqual(publicOne(detail).updates, before.updates);
  await api.close();
});

test("check 5: internal incidents and drafts are unknown to the public and legacy routes", async () => {
  const api = await startApi();
  const internalId = await published(api, { ...DRAFT, visibility: "internal" });
  const draftId = await createDraft(api);
  assert.deepEqual(await publicList(api), []);
  const privateList = await call(api, "GET", "/admin/manual-incidents");
  const v = validateInternalManualIncidentsResponse(privateList.json);
  assert.ok(v.ok);
  assert.deepEqual(
    v.value.map((i) => i.id),
    [draftId, internalId],
  );

  const legacy = { ...DRAFT, visibility: undefined };
  for (const key of ["visibility", "draft"]) {
    const refused = await call(api, "POST", "/manual-incidents", { ...legacy, [key]: "internal" });
    assert.equal(refused.status, 400);
  }
  assert.deepEqual(await publicList(api), []);

  const unknown = async (target: string) => [
    await call(api, "POST", `/manual-incidents/${target}/updates`, {
      status: "identified",
      message: "x",
    }),
    await call(api, "POST", `/manual-incidents/${target}/resolve`),
    await call(api, "DELETE", `/manual-incidents/${target}`),
  ];
  const reference = (await unknown("999999")).map((r) => [r.status, r.text]);
  assert.deepEqual(reference, [
    [404, UNKNOWN_BODY],
    [404, UNKNOWN_BODY],
    [404, UNKNOWN_BODY],
  ]);
  for (const id of [internalId, draftId]) {
    const before = await call(api, "GET", `/admin/manual-incidents/${id}`);
    assert.equal(before.status, 200);
    assert.deepEqual(
      (await unknown(String(id))).map((r) => [r.status, r.text]),
      reference,
    );
    assert.deepEqual((await call(api, "GET", `/admin/manual-incidents/${id}`)).json, before.json);
  }
  await api.close();
});

test("check 6: path, method, bootstrap and auth come first, in the R3 order", async () => {
  const api = await startApi();
  const id = await createDraft(api);
  const cases: [string, string, string | null, number][] = [
    ["GET", "/admin/manual-incidents/abc", null, 404],
    ["GET", "/admin/manual-incidents/1/bogus", null, 404],
    ["DELETE", "/admin/manual-incidents/1/draft/2", null, 404],
    ["DELETE", "/admin/manual-incidents/1/notes/x", null, 404],
    ["PATCH", "/admin/manual-incidents", null, 405],
    ["GET", "/admin/manual-incidents/999999", null, 401],
    ["GET", `/admin/manual-incidents/${id}`, "wrong-token-0123456789", 401],
    ["GET", "/admin/manual-incidents/999999", PROBE, 403],
    ["GET", "/admin/manual-incidents/999999", api.configToken, 403],
    ["POST", `/admin/manual-incidents/${id}/publish`, api.configToken, 403],
    ["GET", "/admin/manual-incidents/999999", ADMIN, 404],
  ];
  for (const [method, path, token, status] of cases) {
    const reply = await call(api, method, path, undefined, token);
    assert.equal(reply.status, status, `${method} ${path}`);
    if (status === 401) assert.equal(reply.headers.get("www-authenticate"), "Bearer");
  }
  const allow = await call(api, "PATCH", `/admin/manual-incidents/${id}`);
  assert.equal(allow.headers.get("allow"), "GET, PUT, DELETE");

  // Config writes off (no admin handler) but bootstrapped: the private list answers.
  assert.equal((await call(api, "GET", "/admin/manual-incidents")).status, 200);
  assert.equal((await call(api, "GET", "/admin/manual-incidents?status=x")).status, 400);

  const off = await startApi({ isAdminOn: false });
  assert.equal((await call(off, "GET", "/admin/manual-incidents")).status, 404);
  assert.equal((await call(off, "POST", "/admin/manual-incidents", DRAFT)).status, 404);
  await off.close();

  const throttled = await startApi({
    throttle: { authorize: () => ({ kind: "throttled", retryAfterSeconds: 7 }) },
  });
  const reply = await call(throttled, "POST", "/admin/manual-incidents", "{bad");
  assert.equal(reply.status, 429);
  assert.equal(reply.headers.get("retry-after"), "7");
  await throttled.close();

  // Auth before the body: a bad body without a token is 401, not 400 or 413.
  const big = "x".repeat(MANUAL_INCIDENT_MAX_BODY_BYTES + 1);
  assert.equal(
    (await call(api, "POST", `/admin/manual-incidents/${id}/publish`, big, null)).status,
    401,
  );
  assert.equal((await call(api, "POST", `/admin/manual-incidents/${id}/publish`, big)).status, 413);
  assert.equal((await call(api, "DELETE", `/admin/manual-incidents/${id}`, big)).status, 413);
  assert.equal((await call(api, "GET", `/admin/manual-incidents/${id}`)).status, 200);
  await api.close();
});

test("check 6: input validation, state rules and limits answer with fixed texts", async () => {
  const api = await startApi();
  const bad: Record<string, unknown>[] = [
    { ...DRAFT, visibility: undefined },
    { ...DRAFT, visibility: "private" },
    { ...DRAFT, status: "resolved" },
    { ...DRAFT, draft: true },
    { ...DRAFT, title: "t".repeat(201) },
    { ...DRAFT, message: "m".repeat(2001) },
  ];
  for (const body of bad) {
    assert.equal((await call(api, "POST", "/admin/manual-incidents", body)).status, 400);
  }
  assert.equal((await call(api, "POST", "/admin/manual-incidents", "{bad")).status, 400);
  const unknownComponent = await call(api, "POST", "/admin/manual-incidents", {
    ...DRAFT,
    componentIds: ["api"],
  });
  assert.equal(errorOf(unknownComponent), 'componentIds: unknown component "api"');

  const draftId = await createDraft(api);
  const notes = `/admin/manual-incidents/${draftId}/notes`;
  assert.equal((await call(api, "POST", notes, { message: "n".repeat(2001) })).status, 400);
  assert.equal((await call(api, "POST", notes, { message: "a\u0007b" })).status, 400);
  assert.equal((await call(api, "POST", notes, { message: "a\nb" })).status, 201);

  const states: [string, string, unknown, number, string][] = [
    [
      "PUT",
      `/admin/manual-incidents/${draftId}/draft`,
      { status: "identified", message: "m" },
      409,
      "manual incident is a draft",
    ],
    [
      "DELETE",
      `/admin/manual-incidents/${draftId}/draft`,
      undefined,
      409,
      "manual incident is a draft",
    ],
    ["DELETE", `${notes}/999999`, undefined, 404, "note not found"],
    ["POST", "/admin/manual-incidents/999999/publish", undefined, 404, "manual incident not found"],
  ];
  for (const [method, path, body, status, error] of states) {
    const reply = await call(api, method, path, body);
    assert.deepEqual([reply.status, errorOf(reply)], [status, error], `${method} ${path}`);
  }

  const openId = await published(api);
  const open = (method: string, sub: string, body?: unknown) =>
    call(api, method, `/admin/manual-incidents/${openId}${sub}`, body);
  assert.equal(errorOf(await open("PUT", "", DRAFT)), "manual incident is published");
  assert.equal(errorOf(await open("DELETE", "/draft")), "manual incident has no draft");
  assert.equal((await open("PUT", "/draft", { status: "identified", message: "m" })).status, 200);
  assert.equal((await open("DELETE", "/draft")).status, 204);
  for (let i = 1; i < 100; i += 1) {
    const r = await call(api, "POST", `/manual-incidents/${openId}/updates`, {
      status: "identified",
      message: `u${i}`,
    });
    assert.equal(r.status, 201);
  }
  const full = await open("PUT", "/draft", { status: "resolved", message: "m" });
  assert.deepEqual(
    [full.status, errorOf(full)],
    [409, "manual incident has the most updates it takes (100)"],
  );

  const resolvedId = await published(api);
  assert.equal((await call(api, "POST", `/manual-incidents/${resolvedId}/resolve`)).status, 200);
  const late = await call(api, "PUT", `/admin/manual-incidents/${resolvedId}/draft`, {
    status: "identified",
    message: "m",
  });
  assert.deepEqual([late.status, errorOf(late)], [409, "manual incident is resolved"]);

  for (let i = 1; i < 100; i += 1) {
    assert.equal((await call(api, "POST", notes, { message: `n${i}` })).status, 201);
  }
  const tooMany = await call(api, "POST", notes, { message: "n" });
  assert.deepEqual(
    [tooMany.status, errorOf(tooMany)],
    [409, "manual incident has the most notes it takes (100)"],
  );

  // Two drafts exist (draftId and none else); fill up to 100.
  for (let i = 1; i < 100; i += 1) await createDraft(api);
  const drafts = await call(api, "POST", "/admin/manual-incidents", DRAFT);
  assert.deepEqual([drafts.status, errorOf(drafts)], [409, "too many draft incidents (100)"]);

  // A component removed after the save blocks the publish; the incident stays a draft.
  api.components.delete("web");
  const blocked = await call(api, "POST", `/admin/manual-incidents/${draftId}/publish`);
  assert.deepEqual(
    [blocked.status, errorOf(blocked)],
    [409, 'componentIds: unknown component "web"'],
  );
  assert.equal(
    internal(await call(api, "GET", `/admin/manual-incidents/${draftId}`)).publishedAt,
    null,
  );

  // Edit and delete close the cycle.
  const edited = await call(api, "PUT", `/admin/manual-incidents/${draftId}`, {
    ...DRAFT,
    componentIds: [],
    title: "Edited",
  });
  assert.equal(internal(edited).title, "Edited");
  const noteId = internal(edited).notes[0]?.id;
  assert.equal((await call(api, "DELETE", `${notes}/${noteId}`)).status, 204);
  assert.equal((await call(api, "DELETE", `/admin/manual-incidents/${draftId}`)).status, 204);
  assert.equal((await call(api, "GET", `/admin/manual-incidents/${draftId}`)).status, 404);
  await api.close();
});

test("check 7: the public detail of a draft, internal, deleted and unknown id is identical", async () => {
  const api = await startApi();
  const draftId = await createDraft(api);
  const internalId = await published(api, { ...DRAFT, visibility: "internal" });
  const deletedId = await published(api);
  const control = await published(api);
  assert.equal((await call(api, "DELETE", `/manual-incidents/${deletedId}`)).status, 204);
  assert.equal(
    (await call(api, "GET", `/manual-incidents/${control}`, undefined, null)).status,
    200,
  );
  assert.equal((await call(api, "GET", `/admin/manual-incidents/${draftId}`)).status, 200);
  assert.equal((await call(api, "GET", `/admin/manual-incidents/${internalId}`)).status, 200);

  const shapes = [];
  for (const id of [draftId, internalId, deletedId, 999999]) {
    const reply = await call(api, "GET", `/manual-incidents/${id}`, undefined, null);
    const headers = [...reply.headers.entries()].filter(([name]) => name !== "date");
    shapes.push({ status: reply.status, text: reply.text, headers });
  }
  assert.equal(shapes[0]?.status, 404);
  assert.equal(shapes[0]?.text, UNKNOWN_BODY);
  for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
  await api.close();
});

test("check 9: a step-6 file serves the same public JSON over HTTP after step 7", async () => {
  const path = join(dir, "v6.db");
  const v6 = openDb(path, MIGRATIONS.slice(0, 6));
  v6.run(
    `INSERT INTO manual_incidents (id, title, impact, component_ids_json, status, created_at, resolved_at)
     VALUES (1, 'Old', 'minor', '["web"]', 'resolved', ?, ?),
            (2, 'Open', 'major', '[]', 'investigating', ?, NULL)`,
    [clock - 3000, clock - 2000, clock - 1000],
  );
  v6.run(
    `INSERT INTO manual_incident_updates (incident_id, n, at, status, message)
     VALUES (1, 0, ?, 'investigating', 'a'), (1, 1, ?, 'resolved', 'b'),
            (2, 0, ?, 'investigating', 'c')`,
    [clock - 3000, clock - 2000, clock - 1000],
  );
  v6.close();
  const api = await startApi({ path });
  const reply = await call(api, "GET", "/manual-incidents", undefined, null);
  const t = clock;
  assert.equal(
    reply.text,
    `[{"id":2,"title":"Open","componentIds":[],"impact":"major","status":"investigating","createdAt":${t - 1000},"resolvedAt":null,"updates":[{"at":${t - 1000},"status":"investigating","message":"c"}]},` +
      `{"id":1,"title":"Old","componentIds":["web"],"impact":"minor","status":"resolved","createdAt":${t - 3000},"resolvedAt":${t - 2000},"updates":[{"at":${t - 3000},"status":"investigating","message":"a"},{"at":${t - 2000},"status":"resolved","message":"b"}]}]`,
  );
  await api.close();
});
