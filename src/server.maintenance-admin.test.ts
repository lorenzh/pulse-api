import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminConfigResponse,
  type AdminMaintenanceList,
  type AuditPage,
  type CheckWithState,
  type Incident,
  type MaintenanceWindow,
  validateAdminConfigExport,
  validateAdminConfigResponse,
  validateAdminMaintenanceList,
  validateAdminMaintenanceWindow,
  validateTokenSecretResponse,
} from "@lorenzh/pulse-contract";
import type { LogLevel } from "@lorenzh/pulse-kit";
import { nodeConfigFs } from "./config-fs.ts";
import { openDb } from "./db.ts";
import { HEARTBEAT_TICK_MS } from "./heartbeat.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const LOCATIONS = ["ap", "eu", "us"] as const;
const probeToken = (location: string): string => `probe-token-${location}-0123456789abcdef`;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const RELOAD_MS = 2000;
const START = NOW - 60_000;
const END = NOW + 3_600_000;
const NOTE = "db upgrade";

const http = (id: string) => ({
  id,
  name: id.toUpperCase(),
  url: `https://${id}.example/`,
  intervalMs: 60000,
});
const heartbeat = (id: string) => ({
  id,
  name: id.toUpperCase(),
  type: "heartbeat",
  period: 60000,
  grace: 0,
  secret: `secret-of-${id}-0123456789abcdef`,
});
const FILE = { checks: [http("a"), http("c"), heartbeat("hb"), heartbeat("hb2")] };
const iso = (ms: number): string => new Date(ms).toISOString();
const fileWindow = (patch: Record<string, unknown> = {}) => ({
  id: "w",
  checkId: "a",
  start: iso(START),
  end: iso(END),
  note: "file note",
  ...patch,
});
const windowBody = (patch: Record<string, unknown> = {}) => ({
  id: "w",
  checkIds: ["a", "b"],
  start: START,
  end: END,
  note: NOTE,
  ...patch,
});

let dir: string;
let file: string;
let dbPath: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-maint-admin-"));
  file = join(dir, "checks.json");
  dbPath = join(dir, "pulse.db");
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: LOCATIONS.map((l) => ({ location: l, token: probeToken(l) })) }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
  );
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  rmSync(dir, { recursive: true, force: true });
});

interface CallInit {
  body?: unknown;
  ifMatch?: string;
  token?: string | null;
  raw?: string;
}

interface Booted {
  base: string;
  api: RunningApi;
  db: () => Database;
  lines: { level: LogLevel; line: string }[];
  clock: { now: number };
  poll(): void;
  tickHeartbeats(): void;
  call(method: string, path: string, init?: CallInit): Promise<Response>;
  /** The shared admin revision, read from `GET /admin/config` (the route an old api serves too). */
  revision(): Promise<string>;
  list(): Promise<AdminMaintenanceList>;
  checks(): Promise<Map<string, CheckWithState>>;
  audit(): Promise<AuditPage["entries"]>;
}

function writeFile(content: unknown): void {
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
}

async function boot(
  options: {
    content?: unknown;
    extra?: Partial<StartDeps>;
    isAdminOn?: boolean;
    clock?: { now: number };
  } = {},
): Promise<Booted> {
  if (options.content !== undefined) writeFile(options.content);
  const clock = options.clock ?? { now: NOW };
  const lines: Booted["lines"] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let db: Database | undefined;
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: dbPath,
      PULSE_CHECKS_FILE: file,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: String(RELOAD_MS),
      ...(options.isAdminOn === false
        ? {}
        : { PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json") }),
    },
    now: () => clock.now,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    write: (level, line) => lines.push({ level, line }),
    openDb: (path) => {
      db = openDb(path);
      return db;
    },
    onSignal: () => () => undefined,
    ...options.extra,
  });
  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    await api.close();
  };
  cleanups.push(close);
  const base = `http://127.0.0.1:${api.port}`;
  const fire = (ms: number): void => {
    const pending = timers.filter((t) => t.ms === ms).pop();
    assert.ok(pending, `a timer of ${ms} ms is scheduled`);
    timers.splice(timers.indexOf(pending), 1);
    pending.fn();
  };
  const call: Booted["call"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? ADMIN}`;
    if (init.ifMatch !== undefined) headers["if-match"] = init.ifMatch;
    const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    return fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  };
  const list = async (): Promise<AdminMaintenanceList> => {
    const r = await call("GET", "/admin/maintenance");
    assert.equal(r.status, 200);
    const parsed = validateAdminMaintenanceList(await r.json());
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  return {
    base,
    api: { ...api, close },
    db: () => {
      assert.ok(db);
      return db;
    },
    lines,
    clock,
    poll: () => fire(RELOAD_MS),
    tickHeartbeats: () => fire(HEARTBEAT_TICK_MS),
    call,
    revision: async () => {
      const tag = (await call("GET", "/admin/config")).headers.get("etag");
      assert.ok(tag);
      return tag;
    },
    list,
    checks: async () => {
      const all = (await (await fetch(`${base}/checks`)).json()) as CheckWithState[];
      return new Map(all.map((c) => [c.id, c]));
    },
    audit: async () => {
      const page = (await (await call("GET", "/admin/audit")).json()) as AuditPage;
      return page.entries;
    },
  };
}

/** The status of a request with a body; fetch refuses a body on GET. */
function sizedStatus(
  base: string,
  method: string,
  path: string,
  body: string,
  ifMatch: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${ADMIN}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "if-match": ifMatch,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    // The server may answer 413 and close before the whole body is sent.
    req.on("error", reject);
    req.end(body);
  });
}

async function createB(b: Booted): Promise<void> {
  const r = await b.call("POST", "/admin/checks", { body: http("b"), ifMatch: await b.revision() });
  assert.equal(r.status, 201);
}

async function postWindow(b: Booted, body: unknown = windowBody()): Promise<Response> {
  return b.call("POST", "/admin/maintenance", { body, ifMatch: await b.revision() });
}

async function postDown(b: Booted, checkId: string, timestamp: number): Promise<void> {
  for (const location of LOCATIONS) {
    const r = await b.call("POST", "/results", {
      token: probeToken(location),
      body: {
        checkId,
        timestamp,
        status: "down",
        statusCode: 500,
        latencyMs: 5,
        reason: "boom",
        location,
        attempts: 1,
      },
    });
    assert.ok(r.status < 300, `result ${checkId} ${location}: ${r.status}`);
  }
}

async function incidentsOf(b: Booted, checkId: string): Promise<Incident[]> {
  const all = (await (await fetch(`${b.base}/incidents`)).json()) as Incident[];
  return all.filter((i) => i.checkId === checkId);
}

function generationOf(db: Database): number {
  const row = db.query("SELECT database_generation AS g FROM config_state").get() as {
    g: number;
  } | null;
  return row?.g ?? 0;
}

// ---- Check 1 ----

test("check 1: a database window silences the named checks of both sources", async () => {
  const b = await boot({ content: FILE });
  await createB(b);
  const bytes = readFileSync(file);
  const rev = await b.revision();
  const created = await b.call("POST", "/admin/maintenance", { body: windowBody(), ifMatch: rev });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/admin/maintenance/w");
  const etag = created.headers.get("etag");
  assert.ok(etag);
  assert.notEqual(etag, rev);
  assert.equal(await b.revision(), etag);
  const view = await created.json();
  assert.deepEqual(view, {
    id: "w",
    index: null,
    source: "database",
    checkIds: ["a", "b"],
    start: START,
    end: END,
    note: NOTE,
    phase: "current",
  });
  assert.equal(validateAdminMaintenanceWindow(view).ok, true);
  assert.deepEqual(readFileSync(file), bytes);

  for (let round = 0; round < 3; round++) {
    await postDown(b, "b", NOW - 30_000 + round * 1000);
    await postDown(b, "c", NOW - 30_000 + round * 1000);
  }
  const checks = await b.checks();
  for (const id of ["a", "b"]) {
    assert.equal(checks.get(id)?.state, "maintenance", id);
    assert.equal(checks.get(id)?.maintenance?.note, NOTE, id);
  }
  assert.notEqual(checks.get("c")?.state, "maintenance");
  assert.equal(checks.get("c")?.maintenance, undefined);
  assert.equal(checks.get("b")?.consecutiveDown, 0);
  assert.equal((await incidentsOf(b, "b")).length, 0);
  assert.equal((await incidentsOf(b, "c")).length, 1);

  const pub = (await (await fetch(`${b.base}/maintenance`)).json()) as MaintenanceWindow[];
  const mine = pub.filter((w) => w.note === NOTE);
  assert.equal(mine.length, 2);
  for (const w of mine)
    assert.deepEqual(
      Object.keys(w).sort((x, y) => x.localeCompare(y)),
      ["checkId", "end", "note", "start"],
    );
  assert.deepEqual(
    mine.map((w) => w.checkId),
    ["a", "b"],
  );
});

test("check 1: a heartbeat inside a database window does not expire", async () => {
  const b = await boot({ content: FILE });
  const r = await postWindow(b, windowBody({ id: "hbw", checkIds: ["hb"] }));
  assert.equal(r.status, 201);
  b.clock.now = NOW + 200_000;
  b.tickHeartbeats();
  const checks = await b.checks();
  assert.equal(checks.get("hb")?.state, "maintenance");
  assert.equal(checks.get("hb2")?.state, "down");
  assert.equal((await incidentsOf(b, "hb")).length, 0);
});

// ---- Check 2 ----

test("check 2: a file id shadows the whole database window and only delete is allowed", async () => {
  const b = await boot({ content: FILE });
  await createB(b);
  assert.equal((await postWindow(b)).status, 201);
  writeFile({ ...FILE, maintenance: [fileWindow()] });
  b.poll();

  const list = await b.list();
  assert.equal(list.windows.length, 1);
  assert.deepEqual(list.windows[0], {
    id: "w",
    index: 0,
    source: "file",
    checkIds: ["a"],
    start: START,
    end: END,
    note: "file note",
    phase: "current",
  });
  assert.deepEqual(
    list.shadowed.map((w) => [w.id, w.source, w.checkIds, w.note]),
    [["w", "database", ["a", "b"], NOTE]],
  );
  let checks = await b.checks();
  assert.equal(checks.get("a")?.maintenance?.note, "file note");
  assert.notEqual(checks.get("b")?.state, "maintenance");

  const rev = await b.revision();
  const put = await b.call("PUT", "/admin/maintenance/w", { body: windowBody(), ifMatch: rev });
  assert.equal(put.status, 409);
  assert.deepEqual(await put.json(), {
    error: 'maintenance "w" is shadowed by the checks file; only delete is allowed',
  });
  const again = await b.call("POST", "/admin/maintenance", { body: windowBody(), ifMatch: rev });
  assert.equal(again.status, 409);

  // The file window leaves: the database copy is effective again, also after a restart.
  writeFile(FILE);
  b.poll();
  assert.equal((await b.checks()).get("b")?.maintenance?.note, NOTE);
  await b.api.close();
  const restarted = await boot();
  assert.equal((await restarted.checks()).get("b")?.maintenance?.note, NOTE);

  // Shadowed again: delete removes only the database copy.
  writeFile({ ...FILE, maintenance: [fileWindow()] });
  restarted.poll();
  const before = readFileSync(file);
  const del = await restarted.call("DELETE", "/admin/maintenance/w", {
    ifMatch: await restarted.revision(),
  });
  assert.equal(del.status, 204);
  assert.deepEqual(readFileSync(file), before);
  const after = await restarted.list();
  assert.deepEqual(after.shadowed, []);
  assert.deepEqual(
    after.windows.map((w) => [w.id, w.source]),
    [["w", "file"]],
  );
  checks = await restarted.checks();
  assert.equal(checks.get("a")?.maintenance?.note, "file note");
  assert.notEqual(checks.get("b")?.state, "maintenance");
});

// ---- Check 3 ----

test("check 3: a broken checks file does not block window writes", async () => {
  const b = await boot({ content: FILE });
  await createB(b);
  writeFileSync(file, "{");
  b.poll();
  const config = async (): Promise<AdminConfigResponse> =>
    (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  const status = (await config()).file;
  assert.equal(status.state, "invalid");

  const created = await postWindow(b);
  assert.equal(created.status, 201);
  const put = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody({ note: "longer" }),
    ifMatch: created.headers.get("etag") ?? "",
  });
  assert.equal(put.status, 200);
  const del = await b.call("DELETE", "/admin/maintenance/w", {
    ifMatch: put.headers.get("etag") ?? "",
  });
  assert.equal(del.status, 204);
  assert.equal((await postWindow(b, windowBody({ id: "kept" }))).status, 201);

  assert.equal(readFileSync(file, "utf8"), "{");
  const now = (await config()).file;
  assert.equal(now.state, "invalid");
  assert.equal(now.lastAppliedAt, status.lastAppliedAt);

  // A start from the snapshot (the file is still broken) keeps the stored window.
  await b.api.close();
  const restarted = await boot();
  assert.deepEqual(
    (await restarted.list()).windows.map((w) => [w.id, w.source, w.checkIds]),
    [["kept", "database", ["a", "b"]]],
  );
  assert.equal((await restarted.checks()).get("b")?.maintenance?.note, NOTE);
});

test("check 3: a read-only directory never answers 503 for a window write", async () => {
  const readOnly: StartDeps["configFs"] = {
    ...nodeConfigFs,
    assertWritable: () => {
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    },
  };
  const b = await boot({ content: FILE, extra: { configFs: readOnly } });
  const created = await postWindow(b, windowBody({ checkIds: ["a"] }));
  assert.equal(created.status, 201);
  const put = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody({ checkIds: ["a"], note: "x" }),
    ifMatch: created.headers.get("etag") ?? "",
  });
  assert.equal(put.status, 200);
  const del = await b.call("DELETE", "/admin/maintenance/w", {
    ifMatch: put.headers.get("etag") ?? "",
  });
  assert.equal(del.status, 204);
  // Component writes keep the file protocol and its 503.
  const component = await b.call("POST", "/admin/components", {
    body: { id: "site", name: "Site", checkIds: ["a"] },
    ifMatch: await b.revision(),
  });
  assert.equal(component.status, 503);
});

// ---- Check 4 ----

test("check 4: a revision from before another write answers 412 and changes nothing", async () => {
  const b = await boot({ content: FILE });
  // Public and old admin reads only, so the same assertions run against an api without the routes.
  const snapshot = async () => ({
    windows: await (await fetch(`${b.base}/maintenance`)).text(),
    config: (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse,
    generation: generationOf(b.db()),
    audit: (await b.audit()).length,
  });

  // before a check write
  const beforeCheck = await b.revision();
  await createB(b);
  let state = await snapshot();
  let r = await b.call("POST", "/admin/maintenance", { body: windowBody(), ifMatch: beforeCheck });
  assert.equal(r.status, 412);
  assert.deepEqual(await snapshot(), state);

  // before a file reload
  const beforeReload = await b.revision();
  writeFile({ ...FILE, checks: [...FILE.checks, http("d")] });
  b.poll();
  state = await snapshot();
  r = await b.call("POST", "/admin/maintenance", { body: windowBody(), ifMatch: beforeReload });
  assert.equal(r.status, 412);
  assert.deepEqual(await snapshot(), state);

  // before another window write, for a window and for a check
  const beforeWindow = await b.revision();
  assert.equal((await postWindow(b)).status, 201);
  state = await snapshot();
  r = await b.call("POST", "/admin/maintenance", {
    body: windowBody({ id: "w2" }),
    ifMatch: beforeWindow,
  });
  assert.equal(r.status, 412);
  r = await b.call("PUT", "/admin/maintenance/w", { body: windowBody(), ifMatch: beforeWindow });
  assert.equal(r.status, 412);
  r = await b.call("DELETE", "/admin/maintenance/w", { ifMatch: beforeWindow });
  assert.equal(r.status, 412);
  r = await b.call("POST", "/admin/checks", { body: http("e"), ifMatch: beforeWindow });
  assert.equal(r.status, 412);
  assert.deepEqual(await snapshot(), state);

  // a stale revision comes before the schema check
  r = await b.call("POST", "/admin/maintenance", { body: { id: "0" }, ifMatch: beforeWindow });
  assert.equal(r.status, 412);

  // If-Match missing and malformed
  r = await b.call("POST", "/admin/maintenance", { body: windowBody({ id: "x" }) });
  assert.equal(r.status, 428);
  for (const bad of ["*", "abc"]) {
    r = await b.call("POST", "/admin/maintenance", { body: windowBody({ id: "x" }), ifMatch: bad });
    assert.equal(r.status, 400, bad);
  }
});

test("check 4: two concurrent creates with one revision give one 201 and one 412", async () => {
  const b = await boot({ content: FILE });
  const rev = await b.revision();
  const results = await Promise.all(
    ["x", "y"].map((id) =>
      b.call("POST", "/admin/maintenance", {
        body: windowBody({ id, checkIds: ["a"] }),
        ifMatch: rev,
      }),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.status).sort((x, y) => x - y),
    [201, 412],
  );
  assert.equal((await b.list()).windows.length, 1);
});

// ---- Check 5: validation and access ----

test("check 5: the counterexamples of the window schema answer their literal status", async () => {
  const b = await boot({ content: { ...FILE, checks: [...FILE.checks, http("web")] } });
  const many = Array.from({ length: 51 }, (_, i) => `k${i}`);
  // A second boot is not needed: create 51 database checks for the 50/51 rows.
  for (const id of many) {
    const r = await b.call("POST", "/admin/checks", {
      body: http(id),
      ifMatch: await b.revision(),
    });
    assert.equal(r.status, 201, id);
  }
  const rows: [string, Record<string, unknown>, number][] = [
    ["empty checkIds", { checkIds: [] }, 422],
    ["51 ids", { checkIds: many }, 422],
    ["duplicate", { checkIds: ["web", "web"] }, 422],
    ["unknown", { checkIds: ["web", "nope"] }, 422],
    ["empty note", { note: "" }, 422],
    ["501 a", { note: "a".repeat(501) }, 422],
    ["251 emoji", { note: "😀".repeat(251) }, 422],
    ["leading space", { note: " x" }, 422],
    ["trailing space", { note: "x " }, 422],
    ["newline", { note: "a\nb" }, 422],
    ["bell", { note: "a\u0007b" }, 422],
    ["fraction", { start: 1.5 }, 422],
    ["negative", { start: -1 }, 422],
    ["year 10000", { end: 253402300800000 }, 422],
    ["max date", { end: 8640000000000000 }, 422],
    ["start == end", { end: START }, 422],
    ["end < start", { end: START - 1 }, 422],
    ["iso", { start: iso(START) }, 422],
    ["id 0", { id: "0" }, 422],
    ["id 12", { id: "12" }, 422],
    ["id Web", { id: "Web" }, 422],
    ["id -a", { id: "-a" }, 422],
    ["id 65", { id: `a${"b".repeat(64)}` }, 422],
    ["id empty", { id: "" }, 422],
  ];
  for (const [name, patch, status] of rows) {
    const r = await postWindow(b, windowBody({ checkIds: ["web"], ...patch }));
    assert.equal(r.status, status, name);
  }
  const unknown = await postWindow(b, windowBody({ checkIds: ["web", "nope"] }));
  assert.deepEqual(await unknown.json(), {
    error: "maintenance.checkIds[1] must reference a configured check",
  });
  const old = await postWindow(b, { checkId: "web", start: START, end: END, note: "n" });
  assert.equal(old.status, 422);
  assert.deepEqual((await b.list()).windows, []);

  const ok: [string, Record<string, unknown>][] = [
    ["50 ids", { id: "fifty", checkIds: many.slice(0, 50) }],
    ["note 1", { id: "n1", note: "a" }],
    ["note 500", { id: "n500", note: "a".repeat(500) }],
    ["250 emoji", { id: "emoji", note: "😀".repeat(250) }],
    ["id a", { id: "a" }],
    ["id 64", { id: `a${"b".repeat(63)}` }],
  ];
  for (const [name, patch] of ok) {
    const r = await postWindow(b, windowBody({ checkIds: ["web"], ...patch }));
    assert.equal(r.status, 201, name);
  }
});

test("check 5: access, method, size and path rules of the window routes", async () => {
  const b = await boot({ content: { ...FILE, maintenance: [fileWindow({ id: undefined })] } });
  const tokenOf = async (scopes: string[]): Promise<string> => {
    const r = await b.call("POST", "/admin/tokens", { body: { name: scopes.join("-"), scopes } });
    assert.equal(r.status, 201);
    const parsed = validateTokenSecretResponse(await r.json());
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.secret;
  };
  const adminOnly = await tokenOf(["admin"]);
  const checksOnly = await tokenOf(["checks"]);
  const read = await tokenOf(["read"]);
  const rev = await b.revision();
  const write = (token: string | null) =>
    b.call("POST", "/admin/maintenance", {
      body: windowBody({ checkIds: ["a"] }),
      ifMatch: rev,
      token,
    });

  assert.equal((await write(null)).status, 401);
  assert.equal((await b.call("GET", "/admin/maintenance", { token: null })).status, 401);
  for (const token of [adminOnly, checksOnly, read, probeToken("eu")]) {
    assert.equal((await write(token)).status, 403);
  }
  assert.equal(
    (await b.call("GET", "/admin/maintenance", { token: probeToken("eu") })).status,
    403,
  );
  for (const token of [read, checksOnly]) {
    const r = await b.call("GET", "/admin/maintenance", { token });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("etag"), rev);
  }

  const big = "x".repeat(1048577);
  for (const [method, path] of [
    ["GET", "/admin/maintenance"],
    ["POST", "/admin/maintenance"],
    ["PUT", "/admin/maintenance/w"],
    ["DELETE", "/admin/maintenance/w"],
  ] as const) {
    assert.equal(await sizedStatus(b.base, method, path, big, rev), 413, `${method} ${path}`);
  }
  assert.equal((await b.call("GET", "/admin/maintenance?x=1")).status, 400);
  assert.equal(
    (await b.call("POST", "/admin/maintenance", { raw: "{", ifMatch: rev })).status,
    400,
  );
  const mismatch = await b.call("PUT", "/admin/maintenance/a", {
    body: windowBody({ id: "b", checkIds: ["a"] }),
    ifMatch: rev,
  });
  assert.equal(mismatch.status, 400);

  const collection = await b.call("PATCH", "/admin/maintenance");
  assert.equal(collection.status, 405);
  assert.equal(collection.headers.get("allow"), "GET, POST");
  const item = await b.call("GET", "/admin/maintenance/w");
  assert.equal(item.status, 405);
  assert.equal(item.headers.get("allow"), "PUT, DELETE");

  // Old index paths: a file window index is read-only, an index beyond the list names nothing.
  const before = readFileSync(file);
  const legacyPut = await b.call("PUT", "/admin/maintenance/0", {
    body: { checkId: "a", start: START, end: END, note: "n" },
    ifMatch: rev,
  });
  assert.equal(legacyPut.status, 400);
  assert.equal((await b.call("DELETE", "/admin/maintenance/0", { ifMatch: rev })).status, 409);
  assert.equal((await b.call("DELETE", "/admin/maintenance/7", { ifMatch: rev })).status, 404);
  assert.equal((await b.call("DELETE", "/admin/maintenance/%ZZ", { ifMatch: rev })).status, 404);
  assert.equal((await b.call("DELETE", "/admin/maintenance/nope", { ifMatch: rev })).status, 404);
  assert.deepEqual(readFileSync(file), before);
});

test("check 5: the admin import off hides the window routes", async () => {
  const b = await boot({ content: FILE, isAdminOn: false });
  assert.equal((await b.call("GET", "/admin/maintenance")).status, 404);
  assert.equal((await b.call("POST", "/admin/maintenance", { body: windowBody() })).status, 404);
});

test("check 5: create collisions and file-only ids answer 409", async () => {
  const b = await boot({ content: { ...FILE, maintenance: [fileWindow({ id: "f" })] } });
  const collide = await postWindow(b, windowBody({ id: "f", checkIds: ["a"] }));
  assert.equal(collide.status, 409);
  assert.equal((await postWindow(b, windowBody({ checkIds: ["a"] }))).status, 201);
  assert.equal((await postWindow(b, windowBody({ checkIds: ["a"] }))).status, 409);
  const rev = await b.revision();
  const put = await b.call("PUT", "/admin/maintenance/f", {
    body: windowBody({ id: "f", checkIds: ["a"] }),
    ifMatch: rev,
  });
  assert.equal(put.status, 409);
  const del = await b.call("DELETE", "/admin/maintenance/f", { ifMatch: rev });
  assert.equal(del.status, 409);
  assert.deepEqual(await del.json(), {
    error: 'maintenance "f" comes from the checks file; edit the file',
  });
});

test("check 5: the note never reaches an error body or a log line", async () => {
  const secretNote = "unique-note-text-5531";
  const b = await boot({ content: FILE });
  const bodies: string[] = [];
  const created = await postWindow(b, windowBody({ checkIds: ["a"], note: secretNote }));
  assert.equal(created.status, 201);
  for (const body of [
    windowBody({ checkIds: ["a"], note: secretNote }),
    windowBody({ checkIds: ["nope"], note: secretNote }),
    windowBody({ id: "x", checkIds: ["a"], note: `${secretNote} ` }),
    { ...windowBody({ id: "y", checkIds: ["a"] }), extra: secretNote },
  ]) {
    const r = await postWindow(b, body);
    assert.ok(r.status >= 400);
    bodies.push(await r.text());
  }
  const stale = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody({ checkIds: ["a"], note: secretNote }),
    ifMatch: `"sha256-${"0".repeat(64)}"`,
  });
  bodies.push(await stale.text());
  for (const text of [...bodies, ...b.lines.map((l) => l.line)]) {
    assert.equal(text.includes(secretNote), false, text);
  }
  assert.equal(JSON.stringify(await b.audit()).includes(secretNote), false);
});

// ---- Check 6: audit ----

test("check 6: each window write adds one audit entry; an audit failure answers 500", async () => {
  const b = await boot({ content: FILE });
  const initial = (await b.audit()).length;
  const created = await postWindow(b, windowBody({ checkIds: ["a"] }));
  const put = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody({ checkIds: ["a"], note: "n2" }),
    ifMatch: created.headers.get("etag") ?? "",
  });
  const del = await b.call("DELETE", "/admin/maintenance/w", {
    ifMatch: put.headers.get("etag") ?? "",
  });
  assert.deepEqual([created.status, put.status, del.status], [201, 200, 204]);
  const entries = (await b.audit()).slice(0, 3).reverse();
  assert.equal((await b.audit()).length, initial + 3);
  assert.deepEqual(
    entries.map((e) => [e.action, e.target, e.actor.name, `"${e.revision}"`]),
    [
      ["maintenance.create", { kind: "maintenance", id: "w" }, "ops", created.headers.get("etag")],
      ["maintenance.replace", { kind: "maintenance", id: "w" }, "ops", put.headers.get("etag")],
      ["maintenance.delete", { kind: "maintenance", id: "w" }, "ops", del.headers.get("etag")],
    ],
  );

  b.db().run(
    "CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
  );
  const listBefore = await b.list();
  const generation = generationOf(b.db());
  const failed = await postWindow(b, windowBody({ checkIds: ["a"] }));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "audit log could not be written" });
  assert.deepEqual(await b.list(), listBefore);
  assert.equal(generationOf(b.db()), generation);
  assert.equal((await b.checks()).get("a")?.state === "maintenance", false);
});

// ---- Check 7: cache ----

test("check 7: an edit of note and end and a delete show on the next read", async () => {
  const b = await boot({ content: FILE });
  const created = await postWindow(b, windowBody({ checkIds: ["a"] }));
  assert.equal((await b.checks()).get("a")?.maintenance?.note, NOTE);
  const put = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody({ checkIds: ["a"], note: "changed", end: END + 1000 }),
    ifMatch: created.headers.get("etag") ?? "",
  });
  assert.equal(put.status, 200);
  const shown = (await b.checks()).get("a")?.maintenance;
  assert.deepEqual(shown, { checkId: "a", start: START, end: END + 1000, note: "changed" });
  const del = await b.call("DELETE", "/admin/maintenance/w", {
    ifMatch: put.headers.get("etag") ?? "",
  });
  assert.equal(del.status, 204);
  const after = (await b.checks()).get("a");
  assert.notEqual(after?.state, "maintenance");
  assert.equal(after?.maintenance, undefined);
});

// ---- Check 9: references ----

test("check 9: a missing member leaves the stored ids and comes back with the check", async () => {
  const b = await boot({ content: FILE });
  await createB(b);
  assert.equal((await postWindow(b)).status, 201);
  const del = await b.call("DELETE", "/admin/checks/b", { ifMatch: await b.revision() });
  assert.equal(del.status, 204);
  assert.deepEqual((await b.list()).windows[0]?.checkIds, ["a", "b"]);
  let checks = await b.checks();
  assert.equal(checks.get("a")?.state, "maintenance");
  assert.equal(checks.has("b"), false);
  const pub = (await (await fetch(`${b.base}/maintenance`)).json()) as MaintenanceWindow[];
  assert.deepEqual(
    pub.map((w) => w.checkId),
    ["a"],
  );
  // A PUT must name only effective ids.
  const put = await b.call("PUT", "/admin/maintenance/w", {
    body: windowBody(),
    ifMatch: await b.revision(),
  });
  assert.equal(put.status, 422);
  await createB(b);
  checks = await b.checks();
  assert.equal(checks.get("b")?.maintenance?.note, NOTE);

  // A reload that removes file check a applies with w naming it.
  writeFile({ ...FILE, checks: FILE.checks.filter((c) => c.id !== "a") });
  b.poll();
  const config = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  assert.equal(config.file.state, "ok");
  assert.deepEqual((await b.list()).windows[0]?.checkIds, ["a", "b"]);
  checks = await b.checks();
  assert.equal(checks.has("a"), false);
  assert.equal(checks.get("b")?.state, "maintenance");
});

// ---- Check 10: old console shapes and the time boundary ----

test("check 10: config and export keep the old shapes with the effective windows", async () => {
  const b = await boot({
    content: { ...FILE, maintenance: [fileWindow({ id: "f", checkId: "c", note: "file" })] },
  });
  await createB(b);
  assert.equal((await postWindow(b)).status, 201);
  const config = await (await b.call("GET", "/admin/config")).json();
  assert.equal(validateAdminConfigResponse(config).ok, true);
  assert.deepEqual((config as AdminConfigResponse).maintenance, [
    { checkId: "c", start: START, end: END, note: "file", index: 0 },
  ]);
  const exported = await (await b.call("GET", "/admin/config/export")).json();
  assert.equal(validateAdminConfigExport(exported).ok, true);
  assert.deepEqual(Reflect.get(exported as object, "maintenance"), [
    {
      checkId: "c",
      start: "2026-10-28T11:59:00.000Z",
      end: "2026-10-28T13:00:00.000Z",
      note: "file",
    },
    {
      checkId: "a",
      start: "2026-10-28T11:59:00.000Z",
      end: "2026-10-28T13:00:00.000Z",
      note: NOTE,
    },
    {
      checkId: "b",
      start: "2026-10-28T11:59:00.000Z",
      end: "2026-10-28T13:00:00.000Z",
      note: NOTE,
    },
  ]);
});

test("time boundary: the largest end exports a four-digit year; a larger end is 422", async () => {
  const b = await boot({ content: FILE });
  const created = await postWindow(b, {
    id: "w",
    checkIds: ["a"],
    start: 253402300799998,
    end: 253402300799999,
    note: "x",
  });
  assert.equal(created.status, 201);
  const exported = await (await b.call("GET", "/admin/config/export")).json();
  const windows = Reflect.get(exported as object, "maintenance") as { end: string }[];
  assert.equal(windows[0]?.end, "9999-12-31T23:59:59.999Z");
  assert.equal(validateAdminConfigExport(exported).ok, true);

  const before = await b.list();
  for (const end of [253402300800000, 8640000000000000]) {
    const body = { id: "w", checkIds: ["a"], start: 253402300799998, end, note: "x" };
    const post = await postWindow(b, { ...body, id: "v" });
    assert.equal(post.status, 422, `POST ${end}`);
    const put = await b.call("PUT", "/admin/maintenance/w", { body, ifMatch: await b.revision() });
    assert.equal(put.status, 422, `PUT ${end}`);
  }
  assert.deepEqual(await b.list(), before);
});

test("the listening line counts the database windows", async () => {
  const b = await boot({ content: FILE });
  assert.equal((await postWindow(b, windowBody({ checkIds: ["a"] }))).status, 201);
  await b.api.close();
  const restarted = await boot();
  const line = restarted.lines.find((l) => l.line.includes('"listening"'))?.line ?? "";
  assert.match(line, /"databaseMaintenanceWindows":1/);
});
