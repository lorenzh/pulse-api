import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdminCheckInput, validateResultsResponse } from "@lorenzh/pulse-contract";
import { parseConfigText } from "./config.ts";
import { createConfigReloader } from "./config-reload.ts";
import { openDb } from "./db.ts";
import { validateResult } from "./server.ts";
import { type RunningApi, startApi } from "./start.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const PROBE = "security-probe-0123456789abcdef";
const ADMIN = "security-admin-0123456789abcdef0123456789abcdef";
const SECRET = "SECURITY-HEARTBEAT-SECRET-0123456789";
const HEADER = "SECURITY-HEADER-SENTINEL-0123456789";
const BODY = "SECURITY-BODY-SENTINEL-0123456789";
const URL_SENTINEL = "SECURITY-URL-SENTINEL-0123456789";
const CONFIG = {
  checks: [
    {
      id: "web",
      name: "Web",
      intervalMs: 60000,
      url: `https://example.invalid/${URL_SENTINEL}`,
      method: "POST",
      headers: { "x-secret": HEADER },
      body: BODY,
    },
    { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0, secret: SECRET },
  ],
};
const BYTES = Buffer.from(JSON.stringify(CONFIG));

function failedReload(failure: unknown): string[] {
  const lines: string[] = [];
  const reloader = createConfigReloader(
    {
      path: "/checks.json",
      fs: { stat: () => ({ mtimeMs: 2, size: BYTES.length, ino: 1 }), readFile: () => BYTES },
      now: () => 0,
      onApply: () => {
        throw failure;
      },
      metrics: { recordConfigReload: () => undefined },
      log: (line) => lines.push(line),
    },
    { config: parseConfigText("/checks.json", BYTES.toString()), revision: "old", stampKey: "old" },
  );
  reloader.poll();
  return lines;
}

test("security: reload metadata rejects control characters and never reads the message", () => {
  for (const suffix of ["\t", "\r", "\n", "\r\n", "\u2028", "\u2029", " ", "x".repeat(65)]) {
    const error = new Error("unused");
    Object.defineProperty(error, "message", {
      get: () => {
        throw new Error("message getter ran");
      },
    });
    error.name = `Error${suffix}`;
    Object.defineProperty(error, "code", { value: `SQLITE_BUSY${suffix}` });
    assert.deepEqual(failedReload(error), [
      "config reload failed: /checks.json: cannot apply the configuration: Error",
    ]);
  }
  for (const failure of [null, undefined, { message: SECRET }, SECRET]) {
    assert.deepEqual(failedReload(failure), [
      "config reload failed: /checks.json: cannot apply the configuration: unknown error",
    ]);
  }
});

test("security: an accessor cannot swap a checked error name for checks-file secrets", () => {
  const message = `${HEADER}\n${SECRET}\r${BODY}\t${URL_SENTINEL}`;
  const error = new Error(message);
  let reads = 0;
  Object.defineProperty(error, "name", {
    get: () => {
      reads += 1;
      return reads === 1 ? "Error" : message;
    },
  });
  const lines = failedReload(error);
  assert.deepEqual(
    lines,
    ["config reload failed: /checks.json: cannot apply the configuration: Error"],
    "the log must contain only validated metadata, never checks-file values or line breaks",
  );
  assert.equal(reads, 0, "untrusted error metadata accessors must not execute");
});

test("security: result validation never invokes optional-field accessors", () => {
  let reads = 0;
  const body = {
    checkId: "web",
    timestamp: NOW,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
  };
  Object.defineProperty(body, "attempts", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("untrusted getter executed");
    },
  });
  assert.doesNotThrow(() => validateResult(body, NOW, () => undefined));
  assert.equal(reads, 0);
});

test("security: contract rejects required getters, array accessors and prototype keys without execution", () => {
  let reads = 0;
  const body = { timestamp: NOW, status: "up", statusCode: 200, latencyMs: 1, reason: null };
  Object.defineProperty(body, "checkId", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("getter");
    },
  });
  assert.equal(typeof validateResult(body, NOW, () => undefined), "string");
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("array getter");
    },
  });
  assert.equal(validateResultsResponse(array).ok, false);
  assert.equal(reads, 0);
  for (const key of ["__proto__", "constructor"]) {
    const input = JSON.parse(
      `{"id":"web","name":"Web","url":"https://example.invalid/","intervalMs":60000,"${key}":{"polluted":true}}`,
    );
    assert.equal(validateAdminCheckInput(input).ok, false);
  }
});

let api: RunningApi;
let dir: string;
const logs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-security-"));
  writeFileSync(join(dir, "checks.json"), BYTES);
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
  );
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "test.db"),
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => logs.push(line),
    openDb: (path) => openDb(path),
  });
});

afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

// Each request comes from its own loopback address, so the many denials of these tests never
// exhaust one client's admin auth budget (10 failures per 60 s). Linux routes all of 127/8.
let peer = 0;
function nextPeer(): string {
  peer += 1;
  return `127.0.${Math.floor(peer / 250) % 250}.${(peer % 250) + 2}`;
}

function call(
  method: string,
  path: string,
  body = "",
  token?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; allow: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: api.port,
        localAddress: nextPeer(),
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            allow: res.headers.allow,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function expectAdminMethod(path: string, allow: string): Promise<void> {
  for (const method of ["GET", "PATCH"]) {
    for (const [token, expected] of [
      [undefined, 401],
      ["wrong-token", 401],
      [PROBE, 403],
      [ADMIN, 405],
    ] as const) {
      const res = await call(method, path, "{", token, { "if-match": "malformed" });
      assert.equal(res.status, expected, `${method} ${path}`);
      assert.equal(res.allow, expected === 405 ? allow : undefined);
      if (expected === 405) assert.equal(res.body, '{"error":"method not allowed"}');
    }
  }
}

test("security HTTP: admin auth precedes method and malformed-body checks on all changed shapes", async () => {
  for (const section of ["checks", "components", "maintenance"]) {
    for (const suffix of ["", "/web", "/missing", "/%ZZ", "/%2e%2e%2f"]) {
      await expectAdminMethod(`/admin/${section}${suffix}`, suffix === "" ? "POST" : "PUT, DELETE");
    }
  }
});

test("security HTTP: method checks reveal no heartbeat ids or secrets and keep public-route order", async () => {
  for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
    for (const id of ["job", "missing", "%ZZ"]) {
      const res = await call(method, `/heartbeat/${id}/${SECRET}`, "{", PROBE);
      assert.equal(res.status, 405);
      assert.equal(res.allow, "GET, POST");
      assert.equal(res.body, method === "HEAD" ? "" : '{"error":"method not allowed"}');
    }
  }
  for (const token of [undefined, "wrong", PROBE]) {
    assert.equal((await call("GET", "/results", "{", token)).status, 405);
    assert.equal((await call("POST", "/probe/checks", "{", token)).status, 405);
    assert.equal((await call("POST", "/results", "{", token)).status, token === PROBE ? 400 : 401);
    assert.equal(
      (await call("GET", "/probe/checks", "", token)).status,
      token === PROBE ? 200 : 401,
    );
  }
  const outputs = [
    logs.join("\n"),
    (await call("GET", "/checks")).body,
    (await call("GET", "/metrics")).body,
  ];
  for (const output of outputs) {
    for (const secret of [SECRET, HEADER, BODY, ADMIN, PROBE]) assert.ok(!output.includes(secret));
  }
  assert.ok(!logs.join("\n").includes(URL_SENTINEL));
});

test("security HTTP: oversized bodies across methods cannot reach a write", async () => {
  const huge = "x".repeat(1000001);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const res = await call(method, "/results", huge, PROBE);
    assert.equal(res.status, method === "POST" ? 413 : 405);
    const admin = await call(method, "/admin/checks/web", "x".repeat(1048577), ADMIN);
    assert.equal(admin.status, method === "PUT" || method === "DELETE" ? 413 : 405);
    const list = await call(method, "/admin/checks", "x".repeat(1048577), ADMIN);
    assert.equal(list.status, method === "POST" ? 413 : 405);
    const ping = await call(method, `/heartbeat/job/${SECRET}`, "x".repeat(1025));
    assert.equal(ping.status, method === "GET" || method === "POST" ? 413 : 405);
  }
  const config = await call("GET", "/admin/config", "", ADMIN);
  assert.equal(config.status, 200);
  assert.ok(config.body.includes('"id":"web"'));
  assert.equal((await call("GET", "/checks/web/results")).body, "[]");
  assert.equal((await call("GET", "/checks/job/results")).body, "[]");
});

test("security HTTP: result boundaries, wrong types and hostile keys reject without throwing", async () => {
  const base = {
    checkId: "web",
    timestamp: NOW,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
  };
  for (const [field, limit, past] of [
    ["reason", "x".repeat(1000), "x".repeat(1001)],
    ["attempts", 100, 101],
    ["latencyMs", 2147483647, 2147483648],
    ["certDaysLeft", 3000000, 3000001],
    ["certDaysLeft", -3000000, -3000001],
    ["timestamp", NOW + 60000, NOW + 60001],
    ["timestamp", NOW - 604800000, NOW - 604800001],
  ] as const) {
    assert.equal(
      (await call("POST", "/results", JSON.stringify({ ...base, [field]: past }), PROBE)).status,
      400,
      field,
    );
    assert.equal(
      (await call("POST", "/results", JSON.stringify({ ...base, [field]: limit }), PROBE)).status,
      204,
      field,
    );
  }
  for (const input of [
    null,
    [],
    1,
    "x",
    { ...base, attempts: null },
    { ...base, latencyMs: "1" },
    { ...base, checkId: "x".repeat(100000) },
  ]) {
    const result = await call("POST", "/results", JSON.stringify(input), PROBE);
    assert.ok(result.status === 400 || result.status === 404, String(result.status));
  }
});

test("security HTTP: admin rejects control characters, wrong types and unknown keys without exposing values", async () => {
  const base = { id: "new", name: "New", url: "https://example.invalid/", intervalMs: 60000 };
  for (const input of [
    null,
    [],
    { ...base, intervalMs: "60000" },
    { ...base, unknown: SECRET },
    { ...base, constructor: SECRET },
    JSON.parse(`${JSON.stringify(base).slice(0, -1)},"__proto__":{"sentinel":"${SECRET}"}}`),
    ...["\t", "\r", "\n"].map((control) => ({
      ...base,
      headers: { "x-secret": HEADER + control + SECRET },
    })),
  ]) {
    const config = await fetch(`http://127.0.0.1:${api.port}/admin/config`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const result = await call("POST", "/admin/checks", JSON.stringify(input), ADMIN, {
      "if-match": config.headers.get("etag") ?? "",
    });
    assert.equal(result.status, 422, JSON.stringify(input));
    assert.ok(!result.body.includes(SECRET) && !result.body.includes(HEADER));
  }
});

// ---- Where values may appear (spec #565, check 4) ----

const LIT_DB = "lit-db-sentinel-1";
const LIT_FILE = "lit-file-sentinel-1";
const BODY_DB = "body-db-sentinel-1";
const BODY_FILE = "body-file-sentinel-1";
const ENV_DB = "PULSE_HEADER_SENTINEL_DB_ENV";
const ENV_FILE = "PULSE_HEADER_SENTINEL_FILE_ENV";
const HB_DB = "hb-db-sentinel-0123456789";
const HB_FILE = "hb-file-sentinel-0123456789";
const LITERALS = [LIT_DB, LIT_FILE, BODY_DB, BODY_FILE];
const ENVS = [ENV_DB, ENV_FILE];
const SECRETS = [HB_DB, HB_FILE];
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

const httpCheck = (id: string, lit: string, env: string, body: string) => ({
  id,
  name: id,
  url: `https://${id}.example/`,
  intervalMs: 60000,
  method: "POST",
  headers: { "x-lit": lit, "x-env": { env } },
  body,
});
const SENTINEL_FILE = {
  checks: [
    httpCheck("file-http", LIT_FILE, ENV_FILE, BODY_FILE),
    { id: "file-hb", name: "File HB", type: "heartbeat", period: 60000, secret: HB_FILE },
  ],
};

function assertAbsent(surface: string, text: string, values: readonly string[]): void {
  for (const value of values) assert.ok(!text.includes(value), `${surface} must not hold ${value}`);
}

async function sentinelSession(work: string): Promise<{ texts: Map<string, string> }> {
  const logs: string[] = [];
  const hups: (() => void)[] = [];
  const s = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(work, "pulse.db"),
      PULSE_CHECKS_FILE: join(work, "checks.json"),
      PULSE_TOKENS_FILE: join(work, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(work, "admin.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: "0",
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => logs.push(line),
    openDb: (path) => openDb(path),
    onSignal: (_signal, handler) => {
      hups.push(handler);
      return () => undefined;
    },
  });
  const base = `http://127.0.0.1:${s.port}`;
  const texts = new Map<string, string>();
  const get = async (path: string, token?: string): Promise<string> => {
    const r = await fetch(`${base}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return r.text();
  };
  const write = async (method: string, path: string, body: unknown): Promise<Response> => {
    const etag = (
      await fetch(`${base}/admin/config`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).headers.get("etag");
    return fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
        "if-match": etag ?? "",
      },
      body: JSON.stringify(body),
    });
  };
  try {
    const writes: string[] = [];
    for (const body of [
      httpCheck("db-http", LIT_DB, ENV_DB, BODY_DB),
      { id: "db-hb", name: "DB HB", type: "heartbeat", period: 60000, grace: 0, secret: HB_DB },
    ]) {
      const r = await write("POST", "/admin/checks", body);
      assert.equal(r.status, 201);
      writes.push(await r.text());
    }
    const put = await write("PUT", "/admin/checks/db-http", {
      ...httpCheck("db-http", LIT_DB, ENV_DB, BODY_DB),
      headers: { "x-lit": { keep: true }, "x-env": { env: ENV_DB } },
      body: { keep: true },
      name: "renamed",
    });
    assert.equal(put.status, 200);
    writes.push(await put.text());
    texts.set("admin writes", writes.join("\n"));
    for (const [id, secret] of [
      ["db-hb", HB_DB],
      ["file-hb", HB_FILE],
    ] as const) {
      const r = await fetch(`${base}/heartbeat/${id}/${secret}`, { method: "POST" });
      assert.ok(r.status < 300, `ping ${id}`);
    }
    // An error body built from a refused write that carries every value.
    const refused = await write("POST", "/admin/checks", {
      ...httpCheck("bad", LIT_DB, ENV_DB, BODY_DB),
      intervalMs: -1,
      secret: HB_DB,
    });
    assert.equal(refused.status, 422);
    texts.set("error body", await refused.text());
    texts.set(
      "public",
      (
        await Promise.all(
          [
            "/checks",
            "/checks/db-http",
            "/checks/file-http",
            "/components",
            "/incidents",
            "/maintenance",
          ].map((p) => get(p)),
        )
      ).join("\n"),
    );
    texts.set("probe", await get("/probe/checks", PROBE));
    texts.set("admin view", await get("/admin/config", ADMIN));
    texts.set("export", await get("/admin/config/export", ADMIN));
    texts.set("audit", await get("/admin/audit", ADMIN));
    texts.set("metrics", await get("/metrics"));
    // A broken file that holds the literal values: file.message must not quote them.
    writeFileSync(join(work, "checks.json"), `{ "x": "${LIT_FILE} ${BODY_FILE} ${HB_FILE}" `);
    for (const hup of hups) hup();
    const status: unknown = JSON.parse(await get("/admin/config", ADMIN));
    texts.set("file.message", JSON.stringify(isObject(status) ? status.file : null));
    // Restore the applied bytes so the snapshot stays the one of the sentinel file.
    writeFileSync(join(work, "checks.json"), JSON.stringify(SENTINEL_FILE));
    for (const hup of hups) hup();
  } finally {
    await s.close();
  }
  texts.set("logs", logs.join("\n"));
  return { texts };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertResponses(texts: Map<string, string>): void {
  const text = (k: string): string => texts.get(k) ?? "";
  for (const surface of ["public", "audit", "logs", "metrics", "error body", "file.message"]) {
    assertAbsent(surface, text(surface), [...LITERALS, ...ENVS, ...SECRETS, "keep"]);
    for (const digest of SECRETS.map(sha256Hex))
      assert.ok(!text(surface).includes(digest), `${surface} has no heartbeat digest`);
  }
  for (const surface of ["admin view", "admin writes"]) {
    assertAbsent(surface, text(surface), [...LITERALS, ...SECRETS]);
    for (const digest of SECRETS.map(sha256Hex)) assert.ok(!text(surface).includes(digest));
  }
  for (const env of ENVS) assert.ok(text("admin view").includes(env), `admin view has ${env}`);
  const view: unknown = JSON.parse(text("admin view"));
  assert.ok(isObject(view) && Array.isArray(view.checks));
  for (const id of ["db-http", "file-http"]) {
    const check: unknown = view.checks.find((c: unknown) => isObject(c) && c.id === id);
    assert.ok(isObject(check) && isObject(check.headers), id);
    assert.deepEqual(check.headers["x-lit"], { keep: true }, id);
    assert.deepEqual(check.body, { keep: true }, id);
  }
  const exported = text("export");
  assertAbsent("export", exported, [...LITERALS, ...SECRETS, '"keep"']);
  for (const digest of SECRETS.map(sha256Hex))
    assert.ok(!exported.includes(digest), "export has no heartbeat digest");
  for (const env of ENVS) assert.ok(exported.includes(env), `export has ${env}`);
  const probe = text("probe");
  for (const value of [...LITERALS, ...ENVS])
    assert.ok(probe.includes(value), `probe has ${value}`);
  assertAbsent("probe", probe, [...SECRETS, '"keep"']);
  for (const digest of SECRETS.map(sha256Hex))
    assert.ok(!probe.includes(digest), "probe has no heartbeat digest");
}

type Row = Record<string, unknown>;

/** Every text cell of the database file, after a checkpoint, with `<table>.<column>`. */
function storedCells(work: string): { where: string; text: string }[] {
  const db = openDb(join(work, "pulse.db"));
  const cells: { where: string; text: string }[] = [];
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    for (const { name } of tables) {
      for (const row of db.query<Row, []>(`SELECT * FROM "${name}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === "string") cells.push({ where: `${name}.${column}`, text: value });
        }
      }
    }
  } finally {
    db.close();
  }
  return cells;
}

function assertStorage(work: string): void {
  const cells = storedCells(work);
  assert.deepEqual(
    cells.filter((c) => c.where === "check_definitions.secret_sha256").map((c) => c.text),
    [sha256Hex(HB_DB)],
  );
  const allowed: Record<string, readonly string[]> = {
    [LIT_DB]: ["check_definitions.check_json", "checks.headers_json"],
    [BODY_DB]: ["check_definitions.check_json", "checks.body"],
    [ENV_DB]: ["check_definitions.check_json", "checks.headers_json"],
    [LIT_FILE]: ["checks.headers_json", "config_state.file_snapshot_json"],
    [BODY_FILE]: ["checks.body", "config_state.file_snapshot_json"],
    [ENV_FILE]: ["checks.headers_json", "config_state.file_snapshot_json"],
    [sha256Hex(HB_DB)]: ["check_definitions.secret_sha256"],
    [sha256Hex(HB_FILE)]: ["config_state.file_snapshot_json"],
  };
  for (const [value, places] of Object.entries(allowed)) {
    const found = cells.filter((c) => c.text.includes(value)).map((c) => c.where);
    assert.ok(found.length > 0, `${value} is stored`);
    for (const where of found)
      assert.ok(places.includes(where), `${value} must not be in ${where}`);
  }
  for (const cell of cells)
    assert.ok(!/"keep"\s*:/.test(cell.text), `no keep marker in ${cell.where}`);
  for (const name of readdirSync(work).filter((n) => n.startsWith("pulse.db"))) {
    const bytes = readFileSync(join(work, name));
    for (const secret of SECRETS) assert.ok(!bytes.includes(secret), `${secret} not in ${name}`);
  }
}

test("security sentinels: every cell of the table of where values may appear", async () => {
  const work = mkdtempSync(join(tmpdir(), "pulse-sentinel-"));
  try {
    writeFileSync(join(work, "checks.json"), JSON.stringify(SENTINEL_FILE));
    writeFileSync(
      join(work, "tokens.json"),
      JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
    );
    writeFileSync(
      join(work, "admin.json"),
      JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
    );
    const { texts } = await sentinelSession(work);
    assertResponses(texts);
    assertStorage(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
