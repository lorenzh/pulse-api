import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminConfigResponse,
  type CheckWithState,
  type ErrorResponse,
  validateAdminCheckView,
  validateAdminComponent,
  validateAdminConfigResponse,
  validateAdminMaintenanceView,
} from "@lorenzh/pulse-contract";
import type { LogLevel } from "@lorenzh/pulse-kit";
import { nodeConfigFs } from "./config-fs.ts";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const RELOAD_MS = 2000;
const SENTINEL_HEADER = "sentinel-header-value-7731";
const SENTINEL_ENV = "SENTINEL_ENV_NAME_7731";
const SENTINEL_BODY = "sentinel-body-text-7731";
const SECRET = "sentinel-secret-7731-abcdef";
const SECRET2 = "rotated-secret-7731-abcdefgh";

const BASE_FILE = {
  checks: [
    { id: "web", name: "Web", url: "https://web.example/", intervalMs: 60000 },
    { id: "api", name: "Api", url: "https://api.example/", intervalMs: 60000 },
  ],
  components: [{ id: "site", name: "Site", checkIds: ["web"] }],
  maintenance: [
    { checkId: "api", start: "2027-01-01T00:00:00Z", end: "2027-01-01T01:00:00Z", note: "n" },
  ],
};

let dir: string;
let file: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-admin-"));
  file = join(dir, "checks.json");
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
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

interface Booted {
  base: string;
  api: RunningApi;
  lines: { level: LogLevel; line: string }[];
  /** Run the pending reload poll once. */
  poll(): void;
  hup(): void;
  call(
    method: string,
    path: string,
    init?: { body?: unknown; ifMatch?: string | null; token?: string | null; raw?: string },
  ): Promise<Response>;
  revision(): Promise<string>;
  metrics(): Promise<string>;
}

async function boot(
  content: unknown = BASE_FILE,
  extra: Partial<StartDeps> = {},
  env: Record<string, string> = {},
  isAdminOn = true,
): Promise<Booted> {
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  const lines: Booted["lines"] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const signals: (() => void)[] = [];
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: ":memory:",
      PULSE_CHECKS_FILE: file,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: String(RELOAD_MS),
      ...(isAdminOn ? { PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json") } : {}),
      ...env,
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    write: (level, line) => lines.push({ level, line }),
    openDb: (path) => openDb(path),
    onSignal: (_signal, handler) => {
      signals.push(handler);
      return () => undefined;
    },
    ...extra,
  });
  cleanups.push(() => api.close());
  const base = `http://127.0.0.1:${api.port}`;
  const call: Booted["call"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? ADMIN}`;
    if (init.ifMatch !== null && init.ifMatch !== undefined) headers["if-match"] = init.ifMatch;
    const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    return fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  };
  return {
    base,
    api,
    lines,
    poll() {
      const pending = timers.filter((t) => t.ms === RELOAD_MS).pop();
      assert.ok(pending, "a reload poll is scheduled");
      timers.splice(timers.indexOf(pending), 1);
      pending.fn();
    },
    hup() {
      for (const handler of signals) handler();
    },
    call,
    revision: async () => {
      const r = await call("GET", "/admin/config");
      const tag = r.headers.get("etag");
      assert.ok(tag);
      return tag;
    },
    metrics: async () => (await fetch(`${base}/metrics`)).text(),
  };
}

function ids(list: CheckWithState[]): string[] {
  return list.map((c) => c.id);
}

async function checkIds(b: Booted): Promise<string[]> {
  return ids((await (await fetch(`${b.base}/checks`)).json()) as CheckWithState[]).sort((a, b) =>
    a.localeCompare(b),
  );
}

function writeExternal(content: unknown): void {
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n  \n`);
}

const NEW_CHECK = { id: "new", name: "New", url: "https://new.example/", intervalMs: 60000 };

// ---- reload ----

test("reload: a valid edit applies checks, components and maintenance", async () => {
  const b = await boot();
  writeExternal({
    checks: [...BASE_FILE.checks, NEW_CHECK],
    components: [{ id: "site", name: "Site", checkIds: ["web", "new"] }],
    maintenance: [
      { checkId: "new", start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z", note: "now" },
    ],
  });
  b.poll();
  assert.deepEqual(await checkIds(b), ["api", "new", "web"]);
  const components = (await (await fetch(`${b.base}/components`)).json()) as {
    checkIds: string[];
  }[];
  assert.deepEqual(components[0]?.checkIds, ["web", "new"]);
  const maintenance = (await (await fetch(`${b.base}/maintenance`)).json()) as unknown[];
  assert.equal(maintenance.length, 1);
  assert.match(await b.metrics(), /^pulse_api_config_reload_total\{result="ok"\} 1$/m);
});

test("reload: a removed check becomes inactive", async () => {
  const b = await boot();
  writeExternal({ checks: [BASE_FILE.checks[0]] });
  b.poll();
  assert.deepEqual(await checkIds(b), ["web"]);
});

test("reload: an invalid edit keeps the config, logs one line and is not logged twice", async () => {
  const b = await boot();
  writeExternal({ checks: [{ id: "x", name: "X", url: "file:///x", intervalMs: 5000 }] });
  b.poll();
  b.poll();
  b.poll();
  assert.deepEqual(await checkIds(b), ["api", "web"]);
  const rejected = b.lines.filter((l) => l.line.includes("config reload rejected"));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.level, "warn");
  assert.match(rejected[0]?.line ?? "", /config reload rejected: .*checks\.json: checks\[0\]\.url/);
  assert.match(await b.metrics(), /^pulse_api_config_reload_total\{result="invalid"\} 1$/m);
});

test("reload: invalid JSON is rejected without quoting content", async () => {
  const b = await boot();
  writeFileSync(file, `{"checks": ${SENTINEL_HEADER}`);
  b.poll();
  const line = b.lines.find((l) => l.line.includes("config reload rejected"))?.line ?? "";
  assert.match(line, /not valid JSON/);
  assert.ok(!line.includes(SENTINEL_HEADER));
});

test("reload: a touch with the same bytes does nothing", async () => {
  const b = await boot();
  const text = readFileSync(file);
  writeFileSync(file, `${text.toString()} `);
  writeFileSync(file, text);
  b.poll();
  assert.match(await b.metrics(), /^pulse_api_config_reload_total\{result="ok"\} 0$/m);
});

test("reload: SIGHUP reloads without a poll", async () => {
  const b = await boot();
  writeExternal({ checks: [...BASE_FILE.checks, NEW_CHECK] });
  b.hup();
  assert.ok((await checkIds(b)).includes("new"));
  assert.match(await b.metrics(), /^pulse_api_config_reload_total\{result="ok"\} 1$/m);
});

test("reload: an idle tick is one stat and no read", async () => {
  const calls: string[] = [];
  const configFs: StartDeps["configFs"] = {
    ...nodeConfigFs,
    stat: (p) => {
      calls.push("stat");
      return nodeConfigFs.stat(p);
    },
    readFile: (p) => {
      calls.push("read");
      return nodeConfigFs.readFile(p);
    },
  };
  const b = await boot(BASE_FILE, { configFs });
  calls.length = 0;
  b.poll();
  assert.deepEqual(calls, ["stat"]);
});

test("reload: the interval setting is checked and shows in the listening line", async () => {
  await assert.rejects(
    boot(BASE_FILE, {}, { PULSE_CHECKS_RELOAD_INTERVAL_MS: "500" }),
    /PULSE_CHECKS_RELOAD_INTERVAL_MS/,
  );
  const b = await boot(BASE_FILE, {}, { PULSE_CHECKS_RELOAD_INTERVAL_MS: "0" });
  const listening = b.lines.find((l) => l.line.includes('"listening"'))?.line ?? "";
  assert.match(listening, /"reloadIntervalMs":0/);
  assert.match(listening, /"configWrites":"on"/);
});

// ---- statuses ----

test("admin: feature off answers 404", async () => {
  const b = await boot(BASE_FILE, {}, {}, false);
  assert.equal((await b.call("GET", "/admin/config")).status, 404);
});

test("admin: 401 without or with a wrong token, 403 for a probe token", async () => {
  const b = await boot();
  assert.equal((await b.call("GET", "/admin/config", { token: null })).status, 401);
  assert.equal(
    (await b.call("GET", "/admin/config", { token: "wrong-token-0123456789" })).status,
    401,
  );
  assert.equal((await b.call("GET", "/admin/config", { token: PROBE })).status, 403);
  assert.equal(
    (await b.call("POST", "/admin/checks", { token: PROBE, body: NEW_CHECK })).status,
    403,
  );
});

test("admin: the status order of the spec", async () => {
  const b = await boot();
  const rev = await b.revision();
  const big = JSON.stringify({ ...NEW_CHECK, name: "x".repeat(1_100_000) });
  assert.equal((await b.call("POST", "/admin/checks", { raw: big, ifMatch: rev })).status, 413);
  assert.equal((await b.call("POST", "/admin/checks", { raw: "{nope", ifMatch: rev })).status, 400);
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: "*" })).status,
    400,
  );
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: "garbage" })).status,
    400,
  );
  assert.equal((await b.call("POST", "/admin/checks", { body: NEW_CHECK })).status, 428);
  assert.equal(
    (await b.call("PUT", "/admin/checks/web", { body: { ...NEW_CHECK }, ifMatch: rev })).status,
    400,
  );
  const stale = `"sha256-${"0".repeat(64)}"`;
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: stale })).status,
    412,
  );
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: { id: "z" }, ifMatch: rev })).status,
    422,
  );
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: BASE_FILE.checks[0], ifMatch: rev })).status,
    409,
  );
  // A bad body is a 422 even when the id exists (create) or is unknown (replace).
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: { id: "web" }, ifMatch: rev })).status,
    422,
  );
  assert.equal(
    (await b.call("PUT", "/admin/checks/ghost", { body: { id: "ghost" }, ifMatch: rev })).status,
    422,
  );
  assert.equal(
    (
      await b.call("PUT", "/admin/checks/ghost", {
        body: { ...NEW_CHECK, id: "ghost" },
        ifMatch: rev,
      })
    ).status,
    404,
  );
  assert.equal((await b.call("DELETE", "/admin/checks/ghost", { ifMatch: rev })).status, 404);
  assert.equal((await b.call("DELETE", "/admin/maintenance/9", { ifMatch: rev })).status, 404);
  assert.equal((await b.call("PATCH", "/admin/checks/web", { ifMatch: rev })).status, 405);
});

test("admin: an http check with a file: url is rejected with 422 and the contract message", async () => {
  const b = await boot();
  const rev = await b.revision();
  const r = await b.call("POST", "/admin/checks", {
    body: { ...NEW_CHECK, url: "file:///x" },
    ifMatch: rev,
  });
  assert.equal(r.status, 422);
  const body = (await r.json()) as ErrorResponse;
  assert.match(body.error, /url: must be an http: or https: URL$/);
  assert.equal(await b.revision(), rev);
  assert.ok(!(await checkIds(b)).includes("new"));
});

test("admin: a read-only directory answers 503 before the revision is compared", async () => {
  const configFs: StartDeps["configFs"] = {
    ...nodeConfigFs,
    assertWritable: () => {
      throw Object.assign(new Error("ro"), { code: "EROFS" });
    },
  };
  const b = await boot(BASE_FILE, { configFs });
  const stale = `"sha256-${"0".repeat(64)}"`;
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: stale });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { error: string }).error, /read-only \(EROFS\)/);
  assert.match(await b.metrics(), /action="create",result="readonly"\} 1/);
});

// ---- happy paths ----

test("admin: GET config conforms to the contract and carries an ETag", async () => {
  const b = await boot();
  const r = await b.call("GET", "/admin/config");
  assert.equal(r.status, 200);
  const body = (await r.json()) as AdminConfigResponse;
  const verdict = validateAdminConfigResponse(body);
  assert.ok(verdict.ok, verdict.ok ? "" : verdict.error);
  assert.equal(r.headers.get("etag"), `"${body.revision}"`);
  assert.equal(body.maintenance[0]?.index, 0);
});

test("admin: check create, replace and delete; each answer conforms and moves the ETag", async () => {
  const b = await boot();
  let rev = await b.revision();
  const created = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/admin/checks/new");
  const createdView = await created.json();
  assert.ok(validateAdminCheckView(createdView).ok);
  assert.notEqual(created.headers.get("etag"), rev);
  rev = created.headers.get("etag") ?? "";
  assert.deepEqual(await checkIds(b), ["api", "new", "web"]);

  const put = await b.call("PUT", "/admin/checks/new", {
    body: { ...NEW_CHECK, name: "Renamed" },
    ifMatch: rev,
  });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { name: string }).name, "Renamed");
  rev = put.headers.get("etag") ?? "";
  const listed = (await (await fetch(`${b.base}/checks`)).json()) as CheckWithState[];
  assert.equal(listed.find((c) => c.id === "new")?.name, "Renamed");

  const del = await b.call("DELETE", "/admin/checks/new", { ifMatch: rev });
  assert.equal(del.status, 204);
  assert.ok(del.headers.get("etag"));
  assert.deepEqual(await checkIds(b), ["api", "web"]);
  // the revision of the answer is the revision of the file
  assert.equal(del.headers.get("etag"), await b.revision());
  const metrics = await b.metrics();
  assert.match(
    metrics,
    /pulse_api_config_writes_total\{kind="check",action="replace",result="ok"\} 1/,
  );
  assert.match(b.lines.map((l) => l.line).join("\n"), /"msg":"config write".*"token":"ops"/);
});

test("admin: components and maintenance windows", async () => {
  const b = await boot();
  let rev = await b.revision();
  const comp = await b.call("POST", "/admin/components", {
    body: { id: "db", name: "DB", checkIds: ["api"] },
    ifMatch: rev,
  });
  assert.equal(comp.status, 201);
  assert.ok(validateAdminComponent(await comp.json()).ok);
  rev = comp.headers.get("etag") ?? "";
  const putComp = await b.call("PUT", "/admin/components/db", {
    body: { id: "db", name: "Database", checkIds: ["api", "web"] },
    ifMatch: rev,
  });
  assert.equal(putComp.status, 200);
  rev = putComp.headers.get("etag") ?? "";

  const win = await b.call("POST", "/admin/maintenance", {
    body: {
      checkId: "web",
      start: Date.parse("2028-01-01T00:00:00Z"),
      end: Date.parse("2028-01-01T01:00:00Z"),
      note: "later",
    },
    ifMatch: rev,
  });
  assert.equal(win.status, 201);
  assert.equal(win.headers.get("location"), "/admin/maintenance/1");
  const winView = await win.json();
  assert.ok(validateAdminMaintenanceView(winView).ok);
  rev = win.headers.get("etag") ?? "";
  const putWin = await b.call("PUT", "/admin/maintenance/1", {
    body: {
      checkId: "web",
      start: "2028-01-01T00:00:00Z",
      end: "2028-01-01T02:00:00Z",
      note: "longer",
    },
    ifMatch: rev,
  });
  assert.equal(putWin.status, 200);
  rev = putWin.headers.get("etag") ?? "";
  assert.equal((await b.call("DELETE", "/admin/maintenance/1", { ifMatch: rev })).status, 204);
  rev = await b.revision();
  assert.equal((await b.call("DELETE", "/admin/components/db", { ifMatch: rev })).status, 204);
  const config = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  assert.equal(config.maintenance.length, 1);
  assert.equal(config.components.length, 1);
});

test("admin: delete is refused with 409 naming the component or the window", async () => {
  const b = await boot();
  const rev = await b.revision();
  const web = await b.call("DELETE", "/admin/checks/web", { ifMatch: rev });
  assert.equal(web.status, 409);
  assert.match(((await web.json()) as { error: string }).error, /component "site"/);
  const api = await b.call("DELETE", "/admin/checks/api", { ifMatch: rev });
  assert.equal(api.status, 409);
  assert.match(((await api.json()) as { error: string }).error, /maintenance\[0\]/);
});

test("admin: a component named by an unresolved manual incident cannot be deleted", async () => {
  const b = await boot();
  const created = await b.call("POST", "/manual-incidents", {
    body: { title: "t", impact: "none", componentIds: ["site"], message: "m" },
  });
  assert.equal(created.status, 201);
  const id = ((await created.json()) as { id: number }).id;
  const rev = await b.revision();
  assert.equal((await b.call("DELETE", "/admin/components/site", { ifMatch: rev })).status, 409);
  await b.call("POST", `/manual-incidents/${id}/resolve`);
  assert.equal((await b.call("DELETE", "/admin/components/site", { ifMatch: rev })).status, 204);
});

test("admin: serialised writes: the second one with the old revision gets 412", async () => {
  const b = await boot();
  const rev = await b.revision();
  const [one, two] = await Promise.all([
    b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev }),
    b.call("POST", "/admin/checks", { body: { ...NEW_CHECK, id: "other" }, ifMatch: rev }),
  ]);
  assert.deepEqual(
    [one.status, two.status].sort((a, b) => a - b),
    [201, 412],
  );
  JSON.parse(readFileSync(file, "utf8"));
});

test("admin: a hand edit makes the old revision stale", async () => {
  const b = await boot();
  const rev = await b.revision();
  writeExternal({ checks: [...BASE_FILE.checks, NEW_CHECK] });
  const r = await b.call("POST", "/admin/checks", {
    body: { ...NEW_CHECK, id: "n2" },
    ifMatch: rev,
  });
  assert.equal(r.status, 412);
});

test("admin: the file keeps its mode and the format has 2 spaces and a final newline", async () => {
  const b = await boot();
  chmodSync(file, 0o640);
  const rev = await b.revision();
  assert.equal(
    (await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev })).status,
    201,
  );
  assert.equal(statSync(file).mode & 0o777, 0o640);
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("}\n"));
  assert.match(text, /\n {2}"checks": \[/);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

// ---- failures at each stage ----

for (const step of ["writeTemp", "rename", "fsyncDir"] as const) {
  test(`admin: a failing ${step} leaves a valid file and no temp file`, async () => {
    let isBroken = false;
    const configFs: StartDeps["configFs"] = {
      ...nodeConfigFs,
      [step]: (...args: unknown[]) => {
        if (isBroken) throw Object.assign(new Error("boom"), { code: "ENOSPC" });
        return (nodeConfigFs[step] as (...a: unknown[]) => unknown)(...args);
      },
    };
    const b = await boot(BASE_FILE, { configFs });
    const before = readFileSync(file, "utf8");
    const rev = await b.revision();
    isBroken = true;
    const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
    assert.equal(r.status, 500);
    JSON.parse(readFileSync(file, "utf8"));
    if (step !== "fsyncDir") assert.equal(readFileSync(file, "utf8"), before);
    // Nothing is applied before the directory fsync succeeds.
    assert.equal(await b.revision(), rev);
    assert.deepEqual(await checkIds(b), ["api", "web"]);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith(".tmp")),
      [],
    );
    assert.match(await b.metrics(), /action="create",result="error"\} 1/);
  });
}

test("admin: EXDEV on rename answers 503 naming the cause", async () => {
  const configFs: StartDeps["configFs"] = {
    ...nodeConfigFs,
    rename: () => {
      throw Object.assign(new Error("x"), { code: "EXDEV" });
    },
  };
  const b = await boot(BASE_FILE, { configFs });
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: await b.revision() });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { error: string }).error, /\(EXDEV\)/);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

// ---- review fix: apply and reload failures, DELETE body limit, status order ----

type Db = ReturnType<typeof openDb>;
const FAIL_UPSERT =
  "CREATE TEMP TRIGGER fail_upsert BEFORE UPDATE ON checks BEGIN SELECT RAISE(ABORT, 'locked'); END";

async function bootWithDb(extra: Partial<StartDeps> = {}): Promise<{ b: Booted; db: () => Db }> {
  let db: Db | undefined;
  const b = await boot(BASE_FILE, {
    openDb: (path) => {
      db = openDb(path);
      return db;
    },
    ...extra,
  });
  return {
    b,
    db: () => {
      assert.ok(db);
      return db;
    },
  };
}

test("review fix: a reload the database rejects keeps the running config and revision", async () => {
  const { b, db } = await bootWithDb();
  const before = await (await b.call("GET", "/admin/config")).json();
  db().prepare(FAIL_UPSERT).run();
  writeExternal({ ...BASE_FILE, components: [{ id: "changed", name: "C", checkIds: ["web"] }] });
  b.poll();
  assert.ok(b.lines.some((l) => l.line.includes("config reload rejected")));
  assert.deepEqual(await (await b.call("GET", "/admin/config")).json(), before);
});

test("review fix: an apply failure after the rename syncs the directory and keeps memory consistent", async () => {
  let dirSyncs = 0;
  const { b, db } = await bootWithDb({
    configFs: {
      ...nodeConfigFs,
      fsyncDir: (d) => {
        dirSyncs += 1;
        nodeConfigFs.fsyncDir(d);
      },
    },
  });
  const before = await (await b.call("GET", "/admin/config")).json();
  db().prepare(FAIL_UPSERT).run();
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: await b.revision() });
  assert.equal(r.status, 500);
  assert.match(((await r.json()) as { error: string }).error, /stored, but applying it failed/);
  assert.equal(dirSyncs, 1, "the directory is synced before the apply");
  assert.ok(readFileSync(file, "utf8").includes('"new"'), "the file is the source of truth");
  assert.deepEqual(await (await b.call("GET", "/admin/config")).json(), before);
  db().prepare("DROP TRIGGER fail_upsert").run();
  b.poll();
  assert.ok((await checkIds(b)).includes("new"), "the next reload applies the stored file");
});

test("review fix: a DELETE body over the limit answers 413 and deletes nothing", async () => {
  const b = await boot({ ...BASE_FILE, checks: [...BASE_FILE.checks, NEW_CHECK] });
  const r = await b.call("DELETE", "/admin/checks/new", {
    raw: "x".repeat(1_100_000),
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 413);
  assert.ok((await checkIds(b)).includes("new"));
});

test("review fix: 400 and 428 come before an unknown id, in the spec order", async () => {
  const b = await boot();
  const rev = await b.revision();
  assert.equal((await b.call("PUT", "/admin/checks/web", { body: NEW_CHECK })).status, 400);
  assert.equal((await b.call("DELETE", "/admin/maintenance/nope")).status, 428);
  assert.equal((await b.call("DELETE", "/admin/checks/%E0%A4%A")).status, 428);
  assert.equal((await b.call("DELETE", "/admin/maintenance/nope", { ifMatch: rev })).status, 404);
  assert.equal((await b.call("DELETE", "/admin/checks/%E0%A4%A", { ifMatch: rev })).status, 404);
  const stale = `"sha256-${"0".repeat(64)}"`;
  assert.equal((await b.call("DELETE", "/admin/maintenance/nope", { ifMatch: stale })).status, 412);
});

// ---- heartbeat secrets ----

test("admin: a heartbeat secret can be set, kept and rotated, and is never read back", async () => {
  const b = await boot();
  const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 };
  let r = await b.call("POST", "/admin/checks", {
    body: { ...hb, secret: SECRET },
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 201);
  const view = (await r.json()) as Record<string, unknown>;
  assert.equal(view.hasSecret, true);
  assert.ok(validateAdminCheckView(view).ok);
  assert.equal((await fetch(`${b.base}/heartbeat/job/${SECRET}`)).status, 204);

  r = await b.call("PUT", "/admin/checks/job", {
    body: { ...hb, name: "Job 2" },
    ifMatch: r.headers.get("etag") ?? "",
  });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${b.base}/heartbeat/job/${SECRET}`)).status, 204);

  r = await b.call("PUT", "/admin/checks/job", {
    body: { ...hb, secret: SECRET2 },
    ifMatch: r.headers.get("etag") ?? "",
  });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${b.base}/heartbeat/job/${SECRET}`)).status, 401);
  assert.equal((await fetch(`${b.base}/heartbeat/job/${SECRET2}`)).status, 204);

  const all = await (await b.call("GET", "/admin/config")).text();
  assert.ok(!all.includes(SECRET) && !all.includes(SECRET2));
  // a heartbeat without a secret on create is refused
  const bad = await b.call("POST", "/admin/checks", {
    body: { ...hb, id: "j2" },
    ifMatch: await b.revision(),
  });
  assert.equal(bad.status, 422);
});

// ---- sentinel ----

test("sentinel: header values, env names, bodies and secrets stay out of every output", async () => {
  const b = await boot();
  const http = {
    id: "post",
    name: "Post",
    url: "https://post.example/",
    intervalMs: 60000,
    method: "POST",
    headers: { "x-token": SENTINEL_HEADER, "x-env": { env: SENTINEL_ENV } },
    body: SENTINEL_BODY,
  };
  const outputs: string[] = [];
  const keep = async (r: Response): Promise<Response> => {
    outputs.push(await r.clone().text());
    return r;
  };
  const r = await keep(
    await b.call("POST", "/admin/checks", { body: http, ifMatch: await b.revision() }),
  );
  assert.equal(r.status, 201);
  const view = JSON.parse(outputs.at(-1) ?? "{}") as { headers?: string[]; hasBody?: boolean };
  assert.deepEqual(view.headers, ["x-token", "x-env"]);
  assert.equal(view.hasBody, true);
  const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0, secret: SECRET };
  await keep(await b.call("POST", "/admin/checks", { body: hb, ifMatch: await b.revision() }));
  await keep(
    await b.call("PUT", "/admin/checks/post", {
      body: { ...http, name: "P2" },
      ifMatch: await b.revision(),
    }),
  );
  // error texts of 409 and 422
  await keep(await b.call("POST", "/admin/checks", { body: http, ifMatch: await b.revision() }));
  await keep(
    await b.call("POST", "/admin/checks", {
      body: { ...http, id: "bad2", intervalMs: -1 },
      ifMatch: await b.revision(),
    }),
  );
  await keep(
    await b.call("POST", "/admin/checks", {
      body: { ...hb, id: "bad3", secret: `${SECRET} !` },
      ifMatch: await b.revision(),
    }),
  );
  for (const path of [
    "/admin/config",
    "/checks",
    "/components",
    "/uptime",
    "/maintenance",
    "/incidents",
    "/locations",
    "/metrics",
  ]) {
    outputs.push(await (await b.call("GET", path)).text());
  }
  const joined = [...outputs, ...b.lines.map((l) => l.line)].join("\n");
  for (const secret of [SENTINEL_HEADER, SENTINEL_ENV, SENTINEL_BODY, SECRET, ADMIN]) {
    assert.ok(!joined.includes(secret), `${secret} leaked`);
  }
  // the probe route still carries them as written (probe token), unchanged
  const probe = await (
    await fetch(`${b.base}/probe/checks`, { headers: { authorization: `Bearer ${PROBE}` } })
  ).text();
  assert.ok(probe.includes(SENTINEL_HEADER));
});
