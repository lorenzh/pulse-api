import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  validateAdminConfigSummary,
  validateAdminMaintenanceView,
} from "@lorenzh/pulse-contract";
import type { LogLevel } from "@lorenzh/pulse-kit";
import { nodeConfigFs } from "./config-fs.ts";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const RELOAD_MS = 2000;
const SENTINEL_HEADER = "sentinel-header-value-7731";
const SENTINEL_ENV = "PULSE_HEADER_SENTINEL_ENV_NAME_7731";
const SENTINEL_BODY = "sentinel-body-text-7731";
const SECRET = "sentinel-secret-7731-abcdef";

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
/** A component write: the file protocol runs for components and windows, not for checks. */
const NEW_COMPONENT = { id: "db", name: "DB", checkIds: ["api"] };

async function componentIds(b: Booted): Promise<string[]> {
  const view = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  return view.components.map((c) => c.id);
}

const hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
/** The admin revision from its formula, independent of the code: file revision, newline, generation. */
const adminRev = (bytes: Buffer, generation: number): string =>
  `"sha256-${hex("sha256-" + hex(bytes) + "\n" + String(generation))}"`;

test("admin: the revision combines the applied file revision with database generation 0", async () => {
  const b = await boot();
  const rev = await b.revision();
  assert.equal(rev, adminRev(readFileSync(file), 0));
  assert.notEqual(rev, `"sha256-${hex(readFileSync(file))}"`);
  // a rejected file does not change the revision
  writeFileSync(file, "{ not json");
  b.poll();
  assert.equal(await b.revision(), rev);
  // the bare file revision is stale
  const stale = await b.call("POST", "/admin/maintenance", {
    body: { checkId: "web", start: 1, end: 2 },
    ifMatch: `"sha256-${hex(readFileSync(file))}"`,
  });
  assert.equal(stale.status, 412);
});

test("admin: a write answers the combined revision of the stored file", async () => {
  const b = await boot();
  const r = await b.call("POST", "/admin/components", {
    body: NEW_COMPONENT,
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("etag"), adminRev(readFileSync(file), 0));
  assert.equal(await b.revision(), adminRev(readFileSync(file), 0));
});

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
  const r = await b.call("POST", "/admin/components", { body: NEW_COMPONENT, ifMatch: stale });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { error: string }).error, /read-only \(EROFS\)/);
  assert.match(await b.metrics(), /kind="component",action="create",result="readonly"\} 1/);
  // A database check write never needs the directory (counterexample 24).
  const check = await b.call("POST", "/admin/checks", {
    body: NEW_CHECK,
    ifMatch: await b.revision(),
  });
  assert.equal(check.status, 201);
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

test("admin: a check of the checks file cannot be replaced or deleted over HTTP", async () => {
  const b = await boot();
  const rev = await b.revision();
  const before = readFileSync(file);
  const web = await b.call("DELETE", "/admin/checks/web", { ifMatch: rev });
  assert.equal(web.status, 409);
  assert.equal(
    ((await web.json()) as ErrorResponse).error,
    'check "web" comes from the checks file; edit the file',
  );
  const put = await b.call("PUT", "/admin/checks/api", {
    body: { ...BASE_FILE.checks[1], name: "x" },
    ifMatch: rev,
  });
  assert.equal(put.status, 409);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(await b.revision(), rev);
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
  const r = await b.call("POST", "/admin/components", { body: NEW_COMPONENT, ifMatch: rev });
  assert.equal(r.status, 412);
});

test("admin: the file keeps its mode and the format has 2 spaces and a final newline", async () => {
  const b = await boot();
  chmodSync(file, 0o640);
  const rev = await b.revision();
  assert.equal(
    (await b.call("POST", "/admin/components", { body: NEW_COMPONENT, ifMatch: rev })).status,
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

const ENOSPC = (): Error => Object.assign(new Error("boom"), { code: "ENOSPC" });

/** The real fs with the temp write, `rename`, or the second (step-6) directory fsync broken. */
function brokenFs(step: "fsync-temp" | "rename" | "fsync-dir", isBroken: () => boolean) {
  const real = nodeConfigFs;
  let dirSyncs = 0;
  return {
    ...real,
    writeTemp: (temp: string, data: Buffer, like: string) => {
      if (isBroken() && step === "fsync-temp") throw ENOSPC();
      real.writeTemp(temp, data, like);
    },
    fsyncDir: (d: string) => {
      if (isBroken()) {
        dirSyncs += 1;
        if (step === "fsync-dir" && dirSyncs === 2) throw ENOSPC();
      }
      real.fsyncDir(d);
    },
    rename: (from: string, to: string) => {
      if (isBroken() && step === "rename") throw ENOSPC();
      real.rename(from, to);
    },
  };
}

for (const step of ["fsync-temp", "rename", "fsync-dir"] as const) {
  test(`admin: a failing ${step} leaves a valid file and no temp file`, async () => {
    let isBroken = false;
    const configFs: StartDeps["configFs"] = brokenFs(step, () => isBroken);
    const b = await boot(BASE_FILE, { configFs });
    const before = readFileSync(file, "utf8");
    const rev = await b.revision();
    isBroken = true;
    const r = await b.call("POST", "/admin/components", { body: NEW_COMPONENT, ifMatch: rev });
    assert.equal(r.status, 500);
    JSON.parse(readFileSync(file, "utf8"));
    if (step !== "fsync-dir") assert.equal(readFileSync(file, "utf8"), before);
    // Nothing is applied before the directory fsync succeeds.
    assert.equal(await b.revision(), rev);
    assert.deepEqual(await componentIds(b), ["site"]);
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
  const r = await b.call("POST", "/admin/components", {
    body: NEW_COMPONENT,
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 503);
  assert.match(((await r.json()) as { error: string }).error, /\(EXDEV\)/);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("admin: a hand edit between the temp file and the rename answers 412 and keeps the edit", async () => {
  let isArmed = false;
  const edited = `${JSON.stringify({ ...BASE_FILE, components: [] }, null, 2)}\n`;
  const configFs: StartDeps["configFs"] = {
    ...nodeConfigFs,
    writeTemp: (temp: string, data: Buffer, like: string) => {
      nodeConfigFs.writeTemp(temp, data, like);
      if (isArmed) {
        isArmed = false;
        writeFileSync(file, edited);
      }
    },
  };
  const b = await boot(BASE_FILE, { configFs });
  const rev = await b.revision();
  isArmed = true;
  const r = await b.call("POST", "/admin/components", { body: NEW_COMPONENT, ifMatch: rev });
  assert.equal(r.status, 412);
  assert.equal(readFileSync(file, "utf8"), edited);
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

/** Only the file state moved: the stored file is valid but not in use. */
function assertNotApplied(before: unknown, after: AdminConfigResponse): void {
  assert.equal(after.file.state, "written-not-applied");
  assert.match(after.file.message ?? "", /^cannot apply the configuration: \w+/);
  assert.deepEqual({ ...after, file: (before as AdminConfigResponse).file }, before);
}

test("review fix: a reload the database rejects keeps the running config and revision", async () => {
  const { b, db } = await bootWithDb();
  const before = await (await b.call("GET", "/admin/config")).json();
  db().prepare(FAIL_UPSERT).run();
  writeExternal({ ...BASE_FILE, components: [{ id: "changed", name: "C", checkIds: ["web"] }] });
  b.poll();
  assert.ok(b.lines.some((l) => l.line.includes("config reload failed")));
  assertNotApplied(
    before,
    (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse,
  );
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
  const r = await b.call("POST", "/admin/components", {
    body: NEW_COMPONENT,
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 500);
  assert.match(((await r.json()) as { error: string }).error, /stored, but applying it failed/);
  assert.equal(dirSyncs, 2, "the temp name and the rename are synced before the apply");
  assert.ok(readFileSync(file, "utf8").includes('"db"'), "the file is the source of truth");
  assertNotApplied(
    before,
    (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse,
  );
  db().prepare("DROP TRIGGER fail_upsert").run();
  b.poll();
  assert.ok((await componentIds(b)).includes("db"), "the next reload applies the stored file");
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

test("admin: a database heartbeat stores only the digest of its secret and never reads it back", async () => {
  const { b, db } = await bootWithDb();
  const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 };
  const r = await b.call("POST", "/admin/checks", {
    body: { ...hb, secret: SECRET },
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 201);
  const view = (await r.json()) as Record<string, unknown>;
  assert.equal(view.hasSecret, true);
  assert.equal(view.source, "database");
  assert.ok(validateAdminCheckView(view).ok);
  const row = db()
    .query<{ check_json: string; secret_sha256: string }, []>(
      "SELECT check_json, secret_sha256 FROM check_definitions WHERE id = 'job'",
    )
    .get();
  assert.equal(row?.secret_sha256, hex(SECRET));
  assert.ok(!row?.check_json.includes(SECRET));
  const all = await (await b.call("GET", "/admin/config")).text();
  assert.ok(!all.includes(SECRET));
  // a heartbeat without a secret on create is refused
  const bad = await b.call("POST", "/admin/checks", {
    body: { ...hb, id: "j2" },
    ifMatch: await b.revision(),
  });
  assert.equal(bad.status, 422);
});

test("admin: a heartbeat with the example placeholder secret answers 422 without the value", async () => {
  const b = await boot();
  const placeholder = "replace-with-xxxxxxxxxxxxxxxx";
  const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 };
  const r = await b.call("POST", "/admin/checks", {
    body: { ...hb, secret: placeholder },
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 422);
  const { error } = (await r.json()) as ErrorResponse;
  assert.match(error, /secret still has the example placeholder secret/);
  assert.ok(!error.includes(placeholder));
  assert.ok(!b.lines.some((l) => l.line.includes(placeholder)));
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
  const view = JSON.parse(outputs.at(-1) ?? "{}") as { headers?: unknown; body?: unknown };
  assert.deepEqual(view.headers, {
    "x-token": { keep: true },
    "x-env": { env: "PULSE_HEADER_SENTINEL_ENV_NAME_7731" },
  });
  assert.deepEqual(view.body, { keep: true });
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
  for (const secret of [SENTINEL_HEADER, SENTINEL_BODY, SECRET, ADMIN]) {
    assert.ok(!joined.includes(secret), `${secret} leaked`);
  }
  // Admin views serve env names; logs must not.
  const logs = b.lines.map((l) => l.line).join("\n");
  assert.ok(!logs.includes(SENTINEL_ENV), "env name leaked to logs");
  // the probe route still carries them as written (probe token), unchanged
  const probe = await (
    await fetch(`${b.base}/probe/checks`, { headers: { authorization: `Bearer ${PROBE}` } })
  ).text();
  assert.ok(probe.includes(SENTINEL_HEADER));
});

test("admin writes: userinfo URL, warnDays 3651 and an unprefixed env name answer 422, the file is unchanged", async () => {
  const b = await boot();
  const before = readFileSync(file, "utf8");
  const http = { id: "w", name: "W", url: "https://w.example/", intervalMs: 60000 };
  const bad = [
    { ...http, url: "https://user:pw@w.example/" },
    { id: "w", name: "W", type: "tls", host: "w.example", intervalMs: 60000, warnDays: 3651 },
    { id: "w", name: "W", type: "domain", domain: "w.example", intervalMs: 60000, warnDays: 3651 },
    { ...http, headers: { Authorization: { env: "SVC_TOKEN" } } },
  ];
  for (const body of bad) {
    const post = await b.call("POST", "/admin/checks", { body, ifMatch: await b.revision() });
    assert.equal(post.status, 422, JSON.stringify(body));
    const put = await b.call("PUT", `/admin/checks/${BASE_FILE.checks[0]?.id}`, {
      body: { ...body, id: BASE_FILE.checks[0]?.id },
      ifMatch: await b.revision(),
    });
    assert.equal(put.status, 422, JSON.stringify(body));
  }
  assert.equal(readFileSync(file, "utf8"), before);
});

// ---- database check writes ----

/** The file operations of a read-only checks file: every write step fails with EROFS. */
const READ_ONLY_FS: StartDeps["configFs"] = {
  ...nodeConfigFs,
  assertWritable: () => {
    throw Object.assign(new Error("ro"), { code: "EROFS" });
  },
  writeTemp: () => {
    throw Object.assign(new Error("ro"), { code: "EROFS" });
  },
  rename: () => {
    throw Object.assign(new Error("ro"), { code: "EROFS" });
  },
};

async function probeChecks(b: Booted): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${b.base}/probe/checks`, {
    headers: { authorization: `Bearer ${PROBE}` },
  });
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>[];
}

function generationOf(db: Db): number | undefined {
  return db
    .query<{ g: number }, []>("SELECT database_generation AS g FROM config_state WHERE id = 1")
    .get()?.g;
}

test("check 1a: POST on a read-only file returns 201 and probes receive the literal definition", async () => {
  const b = await boot(BASE_FILE, { configFs: READ_ONLY_FS });
  const before = readFileSync(file);
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: await b.revision() });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("location"), "/admin/checks/new");
  assert.deepEqual(await r.json(), {
    ...NEW_CHECK,
    retries: 0,
    retryDelayMs: 1000,
    source: "database",
  });
  const probed = (await probeChecks(b)).find((c) => c.id === "new");
  assert.equal(probed?.url, "https://new.example/");
  assert.equal(probed?.name, "New");
  assert.equal(probed?.intervalMs, 60000);
  assert.deepEqual(readFileSync(file), before);
});

test("check 1d: broken bytes stay unchanged after POST 201 with the fresh revision", async () => {
  const b = await boot();
  const applied = readFileSync(file);
  writeFileSync(file, "{ broken");
  b.poll();
  const rev = await b.revision();
  assert.equal(rev, adminRev(applied, 0));
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("etag"), adminRev(applied, 1));
  assert.equal(await b.revision(), adminRev(applied, 1));
  assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("database checks: each committed write advances the generation by one", async () => {
  const { b, db } = await bootWithDb();
  const bytes = readFileSync(file);
  let r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: await b.revision() });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("etag"), adminRev(bytes, 1));
  assert.equal(generationOf(db()), 1);
  r = await b.call("PUT", "/admin/checks/new", {
    body: { ...NEW_CHECK, name: "Renamed" },
    ifMatch: r.headers.get("etag") ?? "",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    ...NEW_CHECK,
    name: "Renamed",
    retries: 0,
    retryDelayMs: 1000,
    source: "database",
  });
  assert.equal(r.headers.get("etag"), adminRev(bytes, 2));
  const listed = (await (await fetch(`${b.base}/checks`)).json()) as CheckWithState[];
  assert.equal(listed.find((c) => c.id === "new")?.name, "Renamed");
  const view = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  assert.ok(validateAdminConfigResponse(view).ok);
  assert.deepEqual(
    view.checks.map((c) => [c.id, c.source]),
    [
      ["web", "file"],
      ["api", "file"],
      ["new", "database"],
    ],
  );
  r = await b.call("DELETE", "/admin/checks/new", { ifMatch: r.headers.get("etag") ?? "" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("etag"), adminRev(bytes, 3));
  assert.equal(generationOf(db()), 3);
  assert.deepEqual(await checkIds(b), ["api", "web"]);
  assert.deepEqual(readFileSync(file), bytes);
  const audit = db()
    .query<{ action: string; target_id: string }, []>(
      "SELECT action, target_id FROM audit_log WHERE action LIKE 'check.%' ORDER BY id",
    )
    .all();
  assert.deepEqual(
    audit.map((a) => `${a.action} ${a.target_id}`),
    ["check.create new", "check.replace new", "check.delete new"],
  );
  assert.match(await b.metrics(), /kind="check",action="replace",result="ok"\} 1/);
});

test("database checks: absent ids 404, a source field 422, a keep marker 422, a stored id 409", async () => {
  const { b, db } = await bootWithDb();
  const rev = await b.revision();
  const ghost = { ...NEW_CHECK, id: "ghost" };
  assert.equal(
    (await b.call("PUT", "/admin/checks/ghost", { body: ghost, ifMatch: rev })).status,
    404,
  );
  assert.equal((await b.call("DELETE", "/admin/checks/ghost", { ifMatch: rev })).status, 404);
  const source = await b.call("POST", "/admin/checks", {
    body: { ...NEW_CHECK, source: "file" },
    ifMatch: rev,
  });
  assert.equal(source.status, 422);
  assert.equal(((await source.json()) as ErrorResponse).error, 'check.source must be "database"');
  const marker = await b.call("POST", "/admin/checks", {
    body: { ...NEW_CHECK, headers: { "x-a": { keep: true } } },
    ifMatch: rev,
  });
  assert.equal(marker.status, 422);
  assert.equal(generationOf(db()), 0);
  assert.equal(await b.revision(), rev);
  const created = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
  assert.equal(created.status, 201);
  const again = await b.call("POST", "/admin/checks", {
    body: NEW_CHECK,
    ifMatch: created.headers.get("etag") ?? "",
  });
  assert.equal(again.status, 409);
  // the revision before the write is stale now
  assert.equal((await b.call("DELETE", "/admin/checks/new", { ifMatch: rev })).status, 412);
});

test("database checks: hasSecret is accepted only as true on a heartbeat", async () => {
  const { b, db } = await bootWithDb();
  const hb = { id: "hb", name: "Hb", type: "heartbeat", period: 60000, grace: 0, secret: SECRET };
  const refused: Record<string, unknown>[] = [
    { ...NEW_CHECK, hasSecret: true },
    { ...NEW_CHECK, hasSecret: false },
    { ...hb, hasSecret: false },
    { ...hb, hasSecret: "true" },
    { ...hb, hasSecret: null },
  ];
  const rev = await b.revision();
  for (const body of refused) {
    const res = await b.call("POST", "/admin/checks", { body, ifMatch: rev });
    assert.equal(res.status, 422, JSON.stringify(body.hasSecret));
    assert.equal(
      ((await res.json()) as ErrorResponse).error,
      "check.hasSecret must be true and only on a heartbeat check",
    );
  }
  assert.equal(generationOf(db()), 0);
  const ok = await b.call("POST", "/admin/checks", {
    body: { ...hb, hasSecret: true },
    ifMatch: rev,
  });
  assert.equal(ok.status, 201);
});

test("database checks: header objects other than an env reference or a marker are refused", async () => {
  const { b, db } = await bootWithDb();
  const base = {
    ...NEW_CHECK,
    id: "hx",
    headers: { "x-token": "S1", "x-env": { env: "PULSE_HEADER_A" } },
  };
  const created = await b.call("POST", "/admin/checks", {
    body: base,
    ifMatch: await b.revision(),
  });
  assert.equal(created.status, 201);
  const malformed: Record<string, unknown>[] = [
    { env: "PULSE_HEADER_A", keep: true },
    { env: "PULSE_HEADER_A", x: 1 },
    { keep: true, x: 1 },
    {},
  ];
  for (const value of malformed) {
    const res = await b.call("PUT", "/admin/checks/hx", {
      body: { ...base, headers: { "x-token": { keep: true }, "x-env": value } },
      ifMatch: await b.revision(),
    });
    assert.equal(res.status, 422, JSON.stringify(value));
    assert.equal(
      ((await res.json()) as ErrorResponse).error,
      "check.headers.x-env: must be a string, an env reference or a keep marker",
    );
  }
  assert.equal(generationOf(db()), 1);
});

test("database checks: fields named keep are literal values, only { keep: true } is a marker", async () => {
  const cases: { body: Record<string, unknown>; status: number }[] = [
    { body: { ...NEW_CHECK, id: "h1", headers: { keep: "literal-header-value" } }, status: 201 },
    { body: { ...NEW_CHECK, id: "h2", headers: { "x-a": "v", keep: "true" } }, status: 201 },
    { body: { ...NEW_CHECK, id: "h3", headers: { "x-a": { keep: true } } }, status: 422 },
    { body: { ...NEW_CHECK, id: "h4", body: { keep: true } }, status: 422 },
    {
      body: { ...NEW_CHECK, id: "h5", jsonAssert: [{ pointer: "/flags", equals: { keep: true } }] },
      status: 201,
    },
    {
      body: {
        ...NEW_CHECK,
        id: "h6",
        jsonAssert: [{ pointer: "/list", equals: [{ keep: true }, { a: { keep: true } }] }],
      },
      status: 201,
    },
  ];
  const b = await boot();
  for (const c of cases) {
    const r = await b.call("POST", "/admin/checks", { body: c.body, ifMatch: await b.revision() });
    assert.equal(r.status, c.status, String(c.body.id));
  }
  const view = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  assert.deepEqual(
    view.checks.map((c) => c.id).filter((id) => id.startsWith("h")),
    ["h1", "h2", "h5", "h6"],
  );
});

test("database checks: of two PUTs with one If-Match the first is 200 and the second 412", async () => {
  const b = await boot();
  const created = await b.call("POST", "/admin/checks", {
    body: NEW_CHECK,
    ifMatch: await b.revision(),
  });
  const rev = created.headers.get("etag") ?? "";
  const [one, two] = await Promise.all([
    b.call("PUT", "/admin/checks/new", { body: { ...NEW_CHECK, name: "A" }, ifMatch: rev }),
    b.call("PUT", "/admin/checks/new", { body: { ...NEW_CHECK, name: "B" }, ifMatch: rev }),
  ]);
  assert.deepEqual([one.status, two.status], [200, 412]);
  const listed = (await (await fetch(`${b.base}/checks`)).json()) as CheckWithState[];
  assert.equal(listed.find((c) => c.id === "new")?.name, "A");
});

test("database checks: a failed audit insert is 500 and changes nothing", async () => {
  const { b, db } = await bootWithDb();
  const rev = await b.revision();
  const audits = db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n;
  db()
    .prepare(
      "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'full'); END",
    )
    .run();
  const r = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
  assert.equal(r.status, 500);
  assert.equal(((await r.json()) as ErrorResponse).error, "audit log could not be written");
  const count = (sql: string): number | undefined => db().query<{ n: number }, []>(sql).get()?.n;
  assert.equal(count("SELECT COUNT(*) AS n FROM check_definitions"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM checks WHERE id = 'new'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM audit_log"), audits);
  assert.equal(generationOf(db()), 0);
  assert.equal(await b.revision(), rev);
  assert.deepEqual(await checkIds(b), ["api", "web"]);
  assert.ok(!(await probeChecks(b)).some((c) => c.id === "new"));
  assert.match(await b.metrics(), /kind="check",action="create",result="error"\} 1/);
});

test("database checks: a restart loads the stored definitions after the file", async () => {
  const dbPath = join(dir, "pulse.db");
  const first = await boot(BASE_FILE, {}, { PULSE_DB: dbPath });
  const created = await first.call("POST", "/admin/checks", {
    body: NEW_CHECK,
    ifMatch: await first.revision(),
  });
  assert.equal(created.status, 201);
  await first.api.close();
  const second = await boot(BASE_FILE, {}, { PULSE_DB: dbPath });
  assert.deepEqual(await checkIds(second), ["api", "new", "web"]);
  assert.equal(await second.revision(), adminRev(readFileSync(file), 1));
  assert.ok((await probeChecks(second)).some((c) => c.id === "new"));
});

// ---- keep markers (lossless save) ----

const ROUND_TRIP = {
  id: "rt",
  name: "Round trip",
  url: "https://rt.example/",
  intervalMs: 60000,
  method: "POST",
  headers: { "X-Token": "S1", "x-env": { env: "PULSE_HEADER_A" } },
  body: "B1",
};

async function createRoundTrip(
  b: Booted,
): Promise<{ view: Record<string, unknown>; etag: string }> {
  const r = await b.call("POST", "/admin/checks", {
    body: ROUND_TRIP,
    ifMatch: await b.revision(),
  });
  assert.equal(r.status, 201);
  const view = (await r.json()) as Record<string, unknown>;
  assert.ok(validateAdminCheckView(view).ok);
  return { view, etag: r.headers.get("etag") ?? "" };
}

async function probed(b: Booted, id: string): Promise<Record<string, unknown> | undefined> {
  return (await probeChecks(b)).find((c) => c.id === id);
}

test("check 1c: a name-only GET-edit-PUT keeps the literal header and body", async () => {
  const b = await boot();
  const { etag } = await createRoundTrip(b);
  const config = (await (await b.call("GET", "/admin/config")).json()) as AdminConfigResponse;
  const view = config.checks.find((c) => c.id === "rt");
  assert.ok(view !== undefined);
  const r = await b.call("PUT", "/admin/checks/rt", {
    body: { ...view, name: "Renamed" },
    ifMatch: etag,
  });
  assert.equal(r.status, 200);
  const p = await probed(b, "rt");
  assert.equal(p?.name, "Renamed");
  assert.deepEqual(p?.headers, { "X-Token": "S1", "x-env": { env: "PULSE_HEADER_A" } });
  assert.equal(p?.body, "B1");
});

test("keep markers: lookup is case-insensitive, the sent name wins, no keep key reaches probes", async () => {
  const b = await boot();
  const { etag } = await createRoundTrip(b);
  const r = await b.call("PUT", "/admin/checks/rt", {
    body: { ...ROUND_TRIP, headers: { "x-token": { keep: true } }, body: { keep: true } },
    ifMatch: etag,
  });
  assert.equal(r.status, 200);
  const text = await (
    await fetch(`${b.base}/probe/checks`, { headers: { authorization: `Bearer ${PROBE}` } })
  ).text();
  assert.ok(!text.includes('"keep"'));
  const p = await probed(b, "rt");
  assert.deepEqual(p?.headers, { "x-token": "S1" });
  assert.equal(p?.body, "B1");
});

test("keep markers: refused without a stored value, in a bad shape, or failing the file rules", async () => {
  const { b, db } = await bootWithDb();
  const { etag } = await createRoundTrip(b);
  const cases: { method: "POST" | "PUT"; body: Record<string, unknown>; error?: string }[] = [
    {
      method: "POST",
      body: { ...ROUND_TRIP, id: "c2", headers: { "x-token": { keep: true } } },
      error: "check.headers.x-token: has no stored value to keep",
    },
    {
      method: "PUT",
      body: { ...ROUND_TRIP, headers: { "x-env": { keep: true } } },
      error: "check.headers.x-env: has no stored value to keep",
    },
    {
      method: "PUT",
      body: { ...ROUND_TRIP, headers: { "x-other": { keep: true } } },
      error: "check.headers.x-other: has no stored value to keep",
    },
    {
      method: "POST",
      body: { ...ROUND_TRIP, id: "c3", body: { keep: true } },
      error: "check.body: has no stored value to keep",
    },
    { method: "PUT", body: { ...ROUND_TRIP, headers: { "X-Token": { keep: true, x: 1 } } } },
    { method: "PUT", body: { ...ROUND_TRIP, headers: { "X-Token": { keep: false } } } },
    { method: "PUT", body: { ...ROUND_TRIP, headers: { "X-Token": { keep: "yes" } } } },
    { method: "PUT", body: { ...ROUND_TRIP, body: { keep: true, x: 1 } } },
    { method: "PUT", body: { ...ROUND_TRIP, method: "GET", body: { keep: true } } },
  ];
  for (const c of cases) {
    const path = c.method === "POST" ? "/admin/checks" : "/admin/checks/rt";
    const r = await b.call(c.method, path, { body: c.body, ifMatch: etag });
    assert.equal(r.status, 422, JSON.stringify(c.body));
    const { error } = (await r.json()) as ErrorResponse;
    if (c.error !== undefined) assert.equal(error, c.error);
    assert.ok(!error.includes("S1") && !error.includes("B1"));
  }
  assert.equal(generationOf(db()), 1);
  const p = await probed(b, "rt");
  assert.equal(p?.body, "B1");
});

test("keep markers: a PUT that omits a header or the body removes it", async () => {
  const b = await boot();
  const { etag } = await createRoundTrip(b);
  const bare: Record<string, unknown> = { ...ROUND_TRIP };
  delete bare.headers;
  delete bare.body;
  const r = await b.call("PUT", "/admin/checks/rt", {
    body: { ...bare, method: "GET", headers: { "x-env": { env: "PULSE_HEADER_A" } } },
    ifMatch: etag,
  });
  assert.equal(r.status, 200);
  const p = await probed(b, "rt");
  assert.deepEqual(p?.headers, { "x-env": { env: "PULSE_HEADER_A" } });
  assert.equal(p?.body, undefined);
});

test("heartbeat secrets: a PUT keeps the digest, a new secret rotates it, a type change needs one", async () => {
  const { b, db } = await bootWithDb();
  const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 };
  const digest = (): string | undefined =>
    db()
      .query<{ d: string }, []>("SELECT secret_sha256 AS d FROM check_definitions WHERE id = 'job'")
      .get()?.d;
  const created = await b.call("POST", "/admin/checks", {
    body: { ...hb, secret: SECRET },
    ifMatch: await b.revision(),
  });
  assert.equal(created.status, 201);
  const view = (await created.json()) as Record<string, unknown>;
  const kept = await b.call("PUT", "/admin/checks/job", {
    body: { ...view, name: "Job 2" },
    ifMatch: created.headers.get("etag") ?? "",
  });
  assert.equal(kept.status, 200);
  assert.equal(digest(), hex(SECRET));
  const rotated = "rotated-secret-0123456789";
  const rot = await b.call("PUT", "/admin/checks/job", {
    body: { ...hb, secret: rotated },
    ifMatch: kept.headers.get("etag") ?? "",
  });
  assert.equal(rot.status, 200);
  assert.equal(digest(), hex(rotated));
  const http = await b.call("POST", "/admin/checks", {
    body: NEW_CHECK,
    ifMatch: rot.headers.get("etag") ?? "",
  });
  assert.equal(http.status, 201);
  const change = await b.call("PUT", "/admin/checks/new", {
    body: { ...hb, id: "new" },
    ifMatch: http.headers.get("etag") ?? "",
  });
  assert.equal(change.status, 422);
  assert.match(((await change.json()) as ErrorResponse).error, /secret/);
});

// ---- precedence: the applied file wins over a database definition with the same id ----

const DB_D = { id: "d", name: "db", url: "https://d.example/", intervalMs: 60000 };
const FILE_D = { id: "d", name: "file", url: "https://d.example/", intervalMs: 60000 };

/** GET /admin/config, checked with the strict response validator and the console's summary one. */
async function adminConfig(b: Booted): Promise<AdminConfigResponse> {
  const body: unknown = await (await b.call("GET", "/admin/config")).json();
  const strict = validateAdminConfigResponse(body);
  assert.ok(strict.ok, strict.ok ? "" : strict.error);
  const summary = validateAdminConfigSummary(body);
  assert.ok(summary.ok, summary.ok ? "" : summary.error);
  return strict.value;
}

async function publicName(b: Booted, id: string): Promise<string | undefined> {
  const list = (await (await fetch(`${b.base}/checks`)).json()) as CheckWithState[];
  return list.find((c) => c.id === id)?.name;
}

async function bootShadowed(): Promise<Booted> {
  const b = await boot();
  const r = await b.call("POST", "/admin/checks", { body: DB_D, ifMatch: await b.revision() });
  assert.equal(r.status, 201);
  writeExternal({ ...BASE_FILE, checks: [...BASE_FILE.checks, FILE_D] });
  b.hup();
  return b;
}

test("check 1b: the file version wins at public and probe reads, shadowed reports the database copy", async () => {
  const b = await bootShadowed();
  assert.equal(await publicName(b, "d"), "file");
  assert.equal((await probed(b, "d"))?.name, "file");
  const view = await adminConfig(b);
  assert.deepEqual(
    view.checks.map((c) => [c.id, c.source]),
    [
      ["web", "file"],
      ["api", "file"],
      ["d", "file"],
    ],
  );
  assert.deepEqual(view.shadowed, [
    { ...DB_D, retries: 0, retryDelayMs: 1000, source: "database" },
  ]);
});

test("precedence: unshadowing keeps the runtime row active and resolves no incident", async () => {
  const b = await bootShadowed();
  writeExternal(BASE_FILE);
  b.hup();
  assert.equal(await publicName(b, "d"), "db");
  assert.ok(!b.lines.some((l) => l.line.includes("removed from the configuration")));
  const view = await adminConfig(b);
  assert.deepEqual(view.shadowed, []);
  assert.equal(view.checks.find((c) => c.id === "d")?.source, "database");
});

test("precedence: a create of an applied file id is 409, of an id only on disk 201 and shadowed after the apply", async () => {
  const b = await boot();
  const taken = await b.call("POST", "/admin/checks", {
    body: { ...NEW_CHECK, id: "web" },
    ifMatch: await b.revision(),
  });
  assert.equal(taken.status, 409);
  writeExternal({ ...BASE_FILE, checks: [...BASE_FILE.checks, FILE_D] });
  const onDisk = await b.call("POST", "/admin/checks", { body: DB_D, ifMatch: await b.revision() });
  assert.equal(onDisk.status, 201);
  b.poll();
  const view = await adminConfig(b);
  assert.deepEqual(
    view.shadowed.map((c) => c.name),
    ["db"],
  );
  assert.equal(await publicName(b, "d"), "file");
});

test("precedence: file-only PUT and DELETE are 409 with unchanged bytes; shadowed PUT 409, DELETE 204", async () => {
  const b = await bootShadowed();
  const bytes = readFileSync(file);
  const rev = await b.revision();
  const cases: { method: "PUT" | "DELETE"; id: string; status: number; error?: string }[] = [
    {
      method: "PUT",
      id: "web",
      status: 409,
      error: 'check "web" comes from the checks file; edit the file',
    },
    {
      method: "DELETE",
      id: "web",
      status: 409,
      error: 'check "web" comes from the checks file; edit the file',
    },
    {
      method: "PUT",
      id: "d",
      status: 409,
      error: 'check "d" is shadowed by the checks file; only delete is allowed',
    },
    { method: "DELETE", id: "nope", status: 404 },
  ];
  for (const c of cases) {
    const body = c.method === "PUT" ? { ...BASE_FILE.checks[0], id: c.id, name: "x" } : undefined;
    const r = await b.call(c.method, `/admin/checks/${c.id}`, { body, ifMatch: rev });
    assert.equal(r.status, c.status, `${c.method} ${c.id}`);
    if (c.error !== undefined) assert.equal(((await r.json()) as ErrorResponse).error, c.error);
  }
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(await b.revision(), rev);
  const del = await b.call("DELETE", "/admin/checks/d", { ifMatch: rev });
  assert.equal(del.status, 204);
  assert.equal(await publicName(b, "d"), "file");
  const view = await adminConfig(b);
  assert.deepEqual(view.shadowed, []);
  assert.equal(view.checks.find((c) => c.id === "d")?.source, "file");
  assert.deepEqual(readFileSync(file), bytes);
});

test("precedence: a keep marker resolves against the database definition, never the file value", async () => {
  const b = await boot();
  const { etag } = await createRoundTrip(b);
  const fileRt = { ...ROUND_TRIP, headers: { "X-Token": "F1" }, body: "F2" };
  writeExternal({ ...BASE_FILE, checks: [...BASE_FILE.checks, fileRt] });
  b.hup();
  assert.deepEqual((await probed(b, "rt"))?.headers, { "X-Token": "F1" });
  writeExternal(BASE_FILE);
  b.hup();
  const rev = await b.revision();
  assert.notEqual(rev, etag);
  const r = await b.call("PUT", "/admin/checks/rt", {
    body: { ...ROUND_TRIP, headers: { "X-Token": { keep: true } }, body: { keep: true } },
    ifMatch: rev,
  });
  assert.equal(r.status, 200);
  const p = await probed(b, "rt");
  assert.deepEqual(p?.headers, { "X-Token": "S1" });
  assert.equal(p?.body, "B1");
});

test("precedence: a broken hand edit keeps the revision; a stale revision after a file apply is 412", async () => {
  const b = await bootShadowed();
  const rev = await b.revision();
  const applied = readFileSync(file);
  writeFileSync(file, "{ broken");
  b.poll();
  assert.equal(await b.revision(), rev);
  assert.equal(rev, adminRev(applied, 1));
  assert.equal((await adminConfig(b)).shadowed.length, 1);
  writeExternal(BASE_FILE);
  b.poll();
  const stale = await b.call("POST", "/admin/checks", { body: NEW_CHECK, ifMatch: rev });
  assert.equal(stale.status, 412);
});

test("precedence: database checks survive SIGHUP, a file without them and a restart", async () => {
  const dbPath = join(dir, "pulse.db");
  const first = await boot(BASE_FILE, {}, { PULSE_DB: dbPath });
  const r = await first.call("POST", "/admin/checks", {
    body: DB_D,
    ifMatch: await first.revision(),
  });
  assert.equal(r.status, 201);
  writeExternal({ ...BASE_FILE, checks: [BASE_FILE.checks[0]], components: [], maintenance: [] });
  first.hup();
  assert.deepEqual(await checkIds(first), ["d", "web"]);
  await first.api.close();
  const second = await boot(
    { ...BASE_FILE, checks: [...BASE_FILE.checks, FILE_D] },
    {},
    { PULSE_DB: dbPath },
  );
  assert.equal(await publicName(second, "d"), "file");
  const view = await adminConfig(second);
  assert.deepEqual(
    view.checks.map((c) => c.id),
    ["web", "api", "d"],
  );
  assert.deepEqual(
    view.shadowed.map((c) => c.name),
    ["db"],
  );
});
