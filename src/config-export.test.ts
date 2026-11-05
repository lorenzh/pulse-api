import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminConfigExport,
  validateAdminConfigExport,
  validateAdminConfigResponse,
  validateTokenSecretResponse,
} from "@lorenzh/pulse-contract";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createMaintenanceStore } from "./maintenance-store.ts";
import { type RunningApi, startApi } from "./start.ts";

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const LIT_DB = "lit-db-sentinel-1";
const BODY_DB = "body-db-sentinel-1";
const LIT_FILE = "lit-file-sentinel-1";
const ENV_DB = "PULSE_HEADER_SENTINEL_DB_ENV";
const ENV_FILE = "PULSE_HEADER_SENTINEL_FILE_ENV";
const HB_DB = "hb-db-sentinel-0123456789";
const HB_FILE = "hb-file-sentinel-0123456789";

const FILE_A = {
  id: "file-a",
  name: "File A",
  url: "https://a.example/",
  intervalMs: 60000,
  headers: { "x-env": { env: ENV_FILE } },
};
const FILE_D = { id: "d", name: "file", url: "https://d.example/", intervalMs: 60000 };
const FILE_HB = { id: "file-hb", name: "File HB", type: "heartbeat", period: 60000 };
const BASE = {
  checks: [FILE_A],
  components: [{ id: "site", name: "Site", checkIds: ["file-a"] }],
  maintenance: [
    {
      checkId: "file-a",
      start: "2027-01-01T01:00:00+01:00",
      end: "2027-01-01T01:30:00Z",
      note: "n",
    },
  ],
};
const DB_HTTP = {
  id: "db-http",
  name: "DB HTTP",
  url: "https://db.example/",
  intervalMs: 60000,
  method: "POST",
  headers: { "x-token": LIT_DB, "x-env": { env: ENV_DB } },
  body: BODY_DB,
};
const DB_D = { id: "d", name: "db", url: "https://d-db.example/", intervalMs: 60000 };
const DB_HB = {
  id: "db-hb",
  name: "DB HB",
  type: "heartbeat",
  period: 60000,
  grace: 0,
  secret: HB_DB,
};

let dir: string;
let file: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-export-"));
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
  api: RunningApi;
  hup(): void;
  call(method: string, path: string, init?: { body?: unknown; token?: string }): Promise<Response>;
  write(method: string, path: string, body: unknown): Promise<Response>;
}

async function boot(content: unknown, dbPath = ":memory:"): Promise<Booted> {
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  const signals: (() => void)[] = [];
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: dbPath,
      PULSE_CHECKS_FILE: file,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: "0",
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
    onSignal: (_signal, handler) => {
      signals.push(handler);
      return () => undefined;
    },
  });
  cleanups.push(() => api.close());
  const base = `http://127.0.0.1:${api.port}`;
  const call: Booted["call"] = (method, path, init = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${init.token ?? ADMIN}`,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const write: Booted["write"] = async (method, path, body) => {
    const etag = (await call("GET", "/admin/config")).headers.get("etag") ?? "";
    return fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
        "if-match": etag,
      },
      body: JSON.stringify(body),
    });
  };
  return {
    api,
    hup: () => {
      for (const handler of signals) handler();
    },
    call,
    write,
  };
}

/** A file with a literal header and a heartbeat, database checks, and a database D shadowed by file D. */
async function bootMixed(): Promise<Booted> {
  const b = await boot({
    ...BASE,
    checks: [
      { ...FILE_A, headers: { ...FILE_A.headers, "x-lit": LIT_FILE } },
      { ...FILE_HB, secret: HB_FILE },
    ],
  });
  for (const body of [DB_HTTP, DB_D, DB_HB]) {
    assert.equal((await b.write("POST", "/admin/checks", body)).status, 201);
  }
  writeFileSync(
    file,
    JSON.stringify({
      ...BASE,
      checks: [
        { ...FILE_A, headers: { ...FILE_A.headers, "x-lit": LIT_FILE } },
        { ...FILE_HB, secret: HB_FILE },
        FILE_D,
      ],
    }),
  );
  b.hup();
  return b;
}

async function exported(b: Booted, token = ADMIN): Promise<{ r: Response; text: string }> {
  const r = await b.call("GET", "/admin/config/export", { token });
  return { r, text: await r.text() };
}

function valid(text: string): AdminConfigExport {
  const parsed = validateAdminConfigExport(JSON.parse(text));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

test("export: effective order, env names kept, literals left out and listed, shadowed never exported", async () => {
  const b = await bootMixed();
  const { r, text } = await exported(b);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="checks.json"');
  assert.equal(r.headers.get("cache-control"), "no-store");
  const config = await b.call("GET", "/admin/config");
  assert.equal(r.headers.get("etag"), config.headers.get("etag"));
  assert.ok(text.startsWith('{\n  "checks": [\n    {\n      "id": "file-a",'), "two-space JSON");
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"), "one final newline");
  assert.deepEqual(valid(text), {
    checks: [
      {
        id: "file-a",
        name: "File A",
        url: "https://a.example/",
        intervalMs: 60000,
        retries: 0,
        retryDelayMs: 1000,
        headers: { "x-env": { env: ENV_FILE } },
      },
      { id: "file-hb", name: "File HB", type: "heartbeat", period: 60000, grace: 0 },
      {
        id: "d",
        name: "file",
        url: "https://d.example/",
        intervalMs: 60000,
        retries: 0,
        retryDelayMs: 1000,
      },
      {
        id: "db-http",
        name: "DB HTTP",
        url: "https://db.example/",
        intervalMs: 60000,
        retries: 0,
        retryDelayMs: 1000,
        method: "POST",
        headers: { "x-env": { env: ENV_DB } },
      },
      { id: "db-hb", name: "DB HB", type: "heartbeat", period: 60000, grace: 0 },
    ],
    components: [{ id: "site", name: "Site", checkIds: ["file-a"] }],
    maintenance: [
      {
        checkId: "file-a",
        start: "2027-01-01T00:00:00.000Z",
        end: "2027-01-01T01:30:00.000Z",
        note: "n",
      },
    ],
    redacted: [
      { checkId: "file-a", field: "headers.x-lit" },
      { checkId: "file-hb", field: "secret" },
      { checkId: "db-http", field: "headers.x-token" },
      { checkId: "db-http", field: "body" },
      { checkId: "db-hb", field: "secret" },
    ],
  });
  for (const value of [LIT_DB, LIT_FILE, BODY_DB, HB_DB, HB_FILE, '"keep"', "d-db.example"]) {
    assert.ok(!text.includes(value), `export must not hold ${value}`);
  }
  assert.throws(() => parseConfig(JSON.parse(text)), "a redacted export does not load");
});

test("export clean: no redacted key, and the document loads as a checks file", async () => {
  const b = await boot(BASE);
  const created = await b.write("POST", "/admin/checks", DB_D);
  assert.equal(created.status, 201);
  const { r, text } = await exported(b);
  assert.equal(r.status, 200);
  const doc = valid(text);
  assert.equal("redacted" in doc, false);
  assert.deepEqual(
    parseConfig(JSON.parse(text)).checks.map((c) => c.id),
    ["file-a", "d"],
  );
});

test("export access: read and checks scopes may export, a probe token is 403, no token is 401", async () => {
  const b = await boot(BASE);
  const tokenWith = async (scopes: string[]): Promise<string> => {
    const r = await b.call("POST", "/admin/tokens", { body: { name: scopes.join("-"), scopes } });
    assert.equal(r.status, 201);
    const parsed = validateTokenSecretResponse(await r.json());
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value.secret;
  };
  for (const scopes of [["read"], ["checks"]]) {
    const { r, text } = await exported(b, await tokenWith(scopes));
    assert.equal(r.status, 200, scopes.join());
    valid(text);
  }
  assert.equal((await exported(b, PROBE)).r.status, 403);
  const bare = await fetch(`http://127.0.0.1:${b.api.port}/admin/config/export`);
  assert.equal(bare.status, 401);
});

test("export refuses any query with 400 and other methods with 405 Allow GET", async () => {
  const b = await boot(BASE);
  for (const query of ["?x=1", "?", "?download"]) {
    const r = await b.call("GET", `/admin/config/export${query}`);
    // "?" alone is an empty search and is the plain route.
    assert.equal(r.status, query === "?" ? 200 : 400, query);
    await r.body?.cancel();
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await b.call(method, "/admin/config/export", { body: {} });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("allow"), "GET");
    await r.body?.cancel();
  }
  const other = await b.call("GET", "/admin/config/other");
  assert.equal(other.status, 404);
});

/** A database file with stored windows, as the window writer will leave it. */
function seededDb(): string {
  const path = join(dir, "seeded.db");
  const db = openDb(path);
  const store = createMaintenanceStore({ db, now: () => NOW });
  store.create({
    id: "late",
    checkIds: ["file-a"],
    start: 253402300799998,
    end: 253402300799999,
    note: "far",
  });
  store.create({ id: "w", checkIds: ["file-a", "gone"], start: 1000, end: 2000, note: "db" });
  store.create({ id: "f", checkIds: ["file-a"], start: 5, end: 6, note: "shadowed" });
  db.close();
  return path;
}

test("export: file windows, then effective database windows flattened; no id, nothing shadowed", async () => {
  const b = await boot({ ...BASE, maintenance: [{ ...BASE.maintenance[0], id: "f" }] }, seededDb());
  const { r, text } = await exported(b);
  assert.equal(r.status, 200);
  const doc = JSON.parse(text) as unknown;
  assert.deepEqual(validateAdminConfigExport(doc).ok, true);
  assert.deepEqual(valid(text).maintenance, [
    {
      checkId: "file-a",
      start: "2027-01-01T00:00:00.000Z",
      end: "2027-01-01T01:30:00.000Z",
      note: "n",
    },
    {
      checkId: "file-a",
      start: "9999-12-31T23:59:59.998Z",
      end: "9999-12-31T23:59:59.999Z",
      note: "far",
    },
    {
      checkId: "file-a",
      start: "1970-01-01T00:00:01.000Z",
      end: "1970-01-01T00:00:02.000Z",
      note: "db",
    },
  ]);

  const config = await (await b.call("GET", "/admin/config")).json();
  assert.equal(validateAdminConfigResponse(config).ok, true);
  assert.deepEqual((config as { maintenance: unknown }).maintenance, [
    {
      checkId: "file-a",
      start: Date.parse("2027-01-01T00:00:00Z"),
      end: Date.parse("2027-01-01T01:30:00Z"),
      note: "n",
      index: 0,
    },
  ]);
});
