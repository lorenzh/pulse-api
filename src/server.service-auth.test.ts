import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const ADMIN = "admin-service-0123456789abcdef0123456789abcdef";
const PROBE = "probe-service-0123456789abcdef";
const UNKNOWN = "unknown-service-0123456789abcdef0123456789";
const NOW = Date.parse("2026-11-06T12:00:00Z");

let dir = "";
let api: RunningApi;
let base = "";
let clock = NOW;
const secrets = new Map<string, string>();
const lines: string[] = [];

beforeEach(async () => {
  clock = NOW;
  lines.length = 0;
  dir = mkdtempSync(join(tmpdir(), "pulse-service-auth-"));
  const checksFile = join(dir, "checks.json");
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }],
    }),
  );
  const adminFile = join(dir, "admin.json");
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }));
  const tokensFile = join(dir, "tokens.json");
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }));
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "pulse.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_API_ADMIN_TOKENS_FILE: adminFile,
      PULSE_TOKENS_FILE: tokensFile,
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => lines.push(line),
    openDb: (path) => openDb(path),
  });
  base = `http://127.0.0.1:${api.port}`;
  for (const [name, scopes] of [
    ["status", ["status"]],
    ["notify", ["notify"]],
    ["read", ["read"]],
  ] as const) {
    const made = await call("POST", "/admin/tokens", ADMIN, { name, scopes });
    assert.equal(made.status, 201, name);
    secrets.set(name, ((await made.json()) as { secret: string }).secret);
  }
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  raw?: string,
): Promise<Response> {
  const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    ...(text === undefined ? {} : { body: text }),
  });
}

function secretOf(name: string): string {
  if (name === "admin") return ADMIN;
  if (name === "probe") return PROBE;
  if (name === "unknown") return UNKNOWN;
  const secret = secrets.get(name);
  assert.ok(secret, name);
  return secret;
}

const REPORT = { at: NOW, startedAt: NOW, appliedRevision: null, rejected: null, locked: [] };

test("every status route has an allowed and a denied case for each token kind", async () => {
  const rows: [string | null, string, string, number][] = [
    [null, "GET", "/admin/status/settings", 401],
    [null, "GET", "/service/status/settings", 401],
    [null, "PUT", "/service/status/report", 401],
    ["unknown", "GET", "/service/status/settings", 401],
    ["read", "GET", "/admin/status/settings", 403],
    ["read", "GET", "/service/status/settings", 403],
    ["read", "PUT", "/service/status/report", 403],
    ["notify", "GET", "/service/status/settings", 403],
    ["notify", "PUT", "/service/status/report", 403],
    ["admin", "GET", "/service/status/settings", 403],
    ["admin", "PUT", "/service/status/report", 403],
    ["probe", "PUT", "/service/status/report", 403],
    ["status", "GET", "/admin/status/settings", 403],
    ["status", "GET", "/admin/config", 403],
    ["status", "GET", "/admin/tokens", 403],
    ["notify", "GET", "/admin/audit", 403],
    ["admin", "GET", "/admin/status/settings", 200],
    ["status", "GET", "/service/status/settings", 200],
    ["status", "PUT", "/service/status/report", 204],
  ];
  for (const [name, method, path, status] of rows) {
    // A fresh throttle window per row, so the denials do not add up to a 429.
    clock += 60_000;
    const token = name === null ? null : secretOf(name);
    const r = await call(method, path, token, method === "PUT" ? REPORT : undefined);
    assert.equal(r.status, status, `${name} ${method} ${path}`);
    if (status === 401) assert.equal(r.headers.get("www-authenticate"), "Bearer");
    if (status === 403) assert.deepEqual(await r.json(), { error: "forbidden" });
  }
});

test("authentication runs before the size limit and the method check", async () => {
  const big = JSON.stringify({ pad: "x".repeat(600_000) });
  assert.equal((await call("PUT", "/service/status/report", null, undefined, big)).status, 401);
  clock += 60_000;
  const admin = await call("PUT", "/service/status/report", ADMIN, undefined, big);
  assert.equal(admin.status, 403);
  clock += 60_000;
  assert.equal((await call("DELETE", "/service/status/settings", null)).status, 401);
  assert.equal(
    (await call("PUT", "/service/status/report", secretOf("status"), undefined, big)).status,
    413,
  );
});

test("/service/* shares the admin throttle budget per client", async () => {
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await call("GET", "/service/status/settings", UNKNOWN)).status, 401);
  }
  const blocked = await call("GET", "/admin/config", ADMIN);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  assert.equal((await call("GET", "/service/status/settings", secretOf("status"))).status, 429);
  clock += 60_001;
  assert.equal((await call("GET", "/service/status/settings", secretOf("status"))).status, 200);
});

test("auth failures carry the literal route label and no secret", async () => {
  await call("GET", "/service/status/settings", UNKNOWN);
  await call("PUT", "/service/status/report", ADMIN, REPORT);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(
    metrics,
    /pulse_api_admin_auth_failures_total\{route="\/service\/status\/settings",status="401"\} 1/,
  );
  assert.match(
    metrics,
    /pulse_api_admin_auth_failures_total\{route="\/service\/status\/report",status="403"\} 1/,
  );
  for (const line of lines) {
    assert.ok(!line.includes(UNKNOWN) && !line.includes(ADMIN), line);
  }
});

test("an unknown /service/ path is 404 and never a public read", async () => {
  for (const path of ["/service/checks", "/service/status", "/service/status/settings/x"]) {
    assert.equal((await call("GET", path, secretOf("status"))).status, 404, path);
  }
});
