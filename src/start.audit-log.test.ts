import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLevel } from "@lorenzh/pulse-kit";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const ADMIN = "admin-sentinel-0123456789abcdef";
const PROBE = "probe-sentinel-0123456789abcdef";
const SECRET = "s3cr3t-sentinel-0123456789";
const PLACEHOLDER = "replace-with-a-random-secret";
const HB = { id: "hb", name: "HB", type: "heartbeat", period: 60000, grace: 0, secret: SECRET };
const C1 = { id: "c1", name: "C1", url: "https://c1.example/", intervalMs: 60000 };

let dir: string;
let api: RunningApi | undefined;
let clock = Date.parse("2026-10-28T12:00:00Z");
const lines: { level: LogLevel; line: string }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-audit-"));
  lines.length = 0;
  writeFileSync(join(dir, "checks.json"), JSON.stringify({ checks: [C1, HB] }));
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "default", token: PROBE }] }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
  );
});
afterEach(async () => {
  await api?.close();
  api = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<string> {
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: ":memory:",
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: "0",
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    write: (level, line) => lines.push({ level, line }),
    openDb: (path) => openDb(path),
  });
  return `http://127.0.0.1:${api.port}`;
}

type Parsed = { level: string; msg: string } & Record<string, unknown>;

function logged(msg: string): Parsed[] {
  return lines.map((l) => JSON.parse(l.line) as Parsed).filter((l) => l.msg === msg);
}

function call(
  host: string,
  method: string,
  path: string,
  token: string | null,
  init: { body?: unknown; ifMatch?: string } = {},
): Promise<Response> {
  // Each request at a new minute, so the rate limit never hides a line in these tests.
  clock += 120_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (init.ifMatch !== undefined) headers["if-match"] = init.ifMatch;
  return fetch(`${host}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

test("admin routes log failed authentication with the route pattern and the token kind", async () => {
  const host = await boot();
  assert.equal((await call(host, "PUT", "/admin/checks/c1", PROBE, { body: C1 })).status, 403);
  assert.equal((await call(host, "GET", "/admin/config", null)).status, 401);
  assert.equal((await call(host, "GET", "/admin/config/x", "not-a-real-token-123456")).status, 401);
  assert.deepEqual(
    logged("admin auth failed").map(({ level, route, status, token, suppressed }) => ({
      level,
      route,
      status,
      token,
      suppressed,
    })),
    [
      { level: "warn", route: "/admin/checks/:id", status: "403", token: "probe", suppressed: "0" },
      { level: "warn", route: "/admin/config", status: "401", token: "missing", suppressed: "0" },
      {
        level: "warn",
        route: "/admin/config/:id",
        status: "401",
        token: "unknown",
        suppressed: "0",
      },
    ],
  );
  const metrics = await (await fetch(`${host}/metrics`)).text();
  assert.match(
    metrics,
    /pulse_api_admin_auth_failures_total\{route="\/admin\/checks\/:id",status="403"\} 1\n/,
  );
});

test("a successful admin write logs config write and no auth failure", async () => {
  const host = await boot();
  const view = await call(host, "GET", "/admin/config", ADMIN);
  const ifMatch = view.headers.get("etag") ?? "";
  const r = await call(host, "POST", "/admin/checks", ADMIN, {
    body: { ...C1, id: "c2" },
    ifMatch,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(
    logged("config write").map(({ level, token, kind, action, id }) => ({
      level,
      token,
      kind,
      action,
      id,
    })),
    [{ level: "info", token: "ops", kind: "check", action: "create", id: "c2" }],
  );
  assert.deepEqual(logged("admin auth failed"), []);
});

test("sentinel: tokens, the heartbeat secret and the placeholder never reach a log line", async () => {
  const host = await boot();
  const result = { checkId: "hb", timestamp: clock, status: "up", statusCode: null, latencyMs: 1 };
  assert.equal(
    (await call(host, "POST", "/results", PROBE, { body: { ...result, reason: null } })).status,
    403,
  );
  const created = await call(host, "POST", "/manual-incidents", ADMIN, {
    body: { title: "t", impact: "none", componentIds: [], message: "m" },
  });
  assert.equal(created.status, 201);
  assert.equal((await call(host, "POST", "/manual-incidents/999/resolve", ADMIN)).status, 404);
  for (const token of [null, PROBE, "not-a-real-token-123456"]) {
    assert.equal(
      (await call(host, "POST", "/manual-incidents", token)).status,
      token === PROBE ? 403 : 401,
    );
    assert.equal(
      (await call(host, "GET", "/admin/checks", token)).status,
      token === PROBE ? 403 : 401,
    );
  }
  const view = await call(host, "GET", "/admin/config", ADMIN);
  const bad = await call(host, "POST", "/admin/checks", ADMIN, {
    body: { ...HB, id: "hb2", secret: PLACEHOLDER },
    ifMatch: view.headers.get("etag") ?? "",
  });
  assert.equal(bad.status, 422);
  assert.equal((await call(host, "GET", `/heartbeat/hb/${SECRET}`, null)).status, 204);

  assert.deepEqual(
    logged("manual incident write").map(({ level, token, action, id }) => ({
      level,
      token,
      action,
      id,
    })),
    [{ level: "info", token: "ops", action: "create", id: "1" }],
  );
  assert.equal(logged("manual incident write failed")[0]?.level, "warn");
  assert.equal(logged("admin auth failed").length, 6);
  const text = lines.map((l) => l.line).join("\n");
  for (const secret of [ADMIN, PROBE, SECRET, PLACEHOLDER, "not-a-real-token-123456"]) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
});
