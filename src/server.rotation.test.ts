import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TokenSecretResponse, validateTokenSecretResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const T = 1_800_000_000_000;
const PROBE = "probe-rotation-0123456789abcdef";
const ADMIN = "admin-rotation-0123456789abcdef";

let dir = "";
let dbPath = "";
let clock = T;
let api: RunningApi;

function deps(): StartDeps {
  return {
    env: {
      PORT: "0",
      PULSE_DB: dbPath,
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin-tokens.json"),
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-rotation-"));
  dbPath = join(dir, "pulse.db");
  writeFileSync(
    join(dir, "checks.json"),
    JSON.stringify({
      checks: [{ id: "x", name: "X", url: "https://x.invalid/", intervalMs: 1000 }],
    }),
  );
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
  );
  writeFileSync(
    join(dir, "admin-tokens.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
  );
  api = await startApi(deps());
});
afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

function parsed(reply: { status: number; text: string }): TokenSecretResponse {
  const result = validateTokenSecretResponse(JSON.parse(reply.text));
  if (!result.ok) throw new Error(`${reply.status} ${result.error}`);
  return result.value;
}

async function create(body: Record<string, unknown>): Promise<TokenSecretResponse> {
  clock = T;
  return parsed(await call("POST", "/admin/tokens", ADMIN, body));
}

const config = async (secret: string): Promise<number> =>
  (await call("GET", "/admin/config", secret)).status;

async function overlap(): Promise<void> {
  const made = await create({ name: "r", scopes: ["read"] });
  const rotated = await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN);
  assert.equal(rotated.status, 200);
  const next = parsed(rotated);
  assert.equal(next.previousValidUntil, T + 600_000);
  assert.equal(next.token.previousValidUntil, T + 600_000);
  assert.notEqual(next.secret, made.secret);

  clock = T + 599_999;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [200, 200]);
  clock = T + 600_000;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [401, 200]);
}

async function restartKeepsDeadline(): Promise<void> {
  const made = await create({ name: "restart", scopes: ["read"] });
  const next = parsed(await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN));
  clock = T + 300_000;
  await api.close();
  api = await startApi(deps());
  clock = T + 599_999;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [200, 200]);
  clock = T + 600_000;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [401, 200]);
}

async function expiryCap(): Promise<void> {
  const made = await create({ name: "exp", scopes: ["read"], expiresAt: T + 120_000 });
  const next = parsed(await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN));
  clock = T + 119_999;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [200, 200]);
  clock = T + 120_000;
  assert.deepEqual([await config(made.secret), await config(next.secret)], [401, 401]);
  const expired = await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN);
  assert.deepEqual(
    [expired.status, JSON.parse(expired.text)],
    [409, { error: "token is expired" }],
  );
}

async function repeatAndRevoke(): Promise<void> {
  const made = await create({ name: "twice", scopes: ["read"] });
  const next = parsed(await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN));
  clock = T + 1;
  const again = await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN, {});
  assert.deepEqual(
    [again.status, JSON.parse(again.text)],
    [409, { error: "a rotation is still in its overlap" }],
  );
  const revoked = await call("POST", `/admin/tokens/${made.token.id}/revoke`, ADMIN);
  assert.equal(revoked.status, 200);
  assert.deepEqual([await config(made.secret), await config(next.secret)], [401, 401]);
  const twice = await call("POST", `/admin/tokens/${made.token.id}/revoke`, ADMIN);
  assert.deepEqual([twice.status, JSON.parse(twice.text)], [409, { error: "token is revoked" }]);

  const other = await create({ name: "later", scopes: ["read"] });
  await call("POST", `/admin/tokens/${other.token.id}/rotate`, ADMIN);
  clock = T + 600_000;
  assert.equal((await call("POST", `/admin/tokens/${other.token.id}/rotate`, ADMIN)).status, 200);
}

async function probeRoutes(): Promise<void> {
  const made = await create({ name: "p", scopes: ["probe"], location: "eu" });
  const next = parsed(await call("POST", `/admin/tokens/${made.token.id}/rotate`, ADMIN));
  clock = T + 1000;
  const result = (location: string, i: number) => ({
    checkId: "x",
    timestamp: T + 1000 + i,
    status: "up",
    statusCode: 200,
    latencyMs: 3,
    reason: null,
    attempts: 1,
    location,
  });
  for (const [i, secret] of [made.secret, next.secret].entries()) {
    assert.equal((await call("GET", "/probe/checks", secret)).status, 200);
    assert.equal((await call("POST", "/results", secret, result("eu", i))).status, 204);
    const spoofed = await call("POST", "/results", secret, result("us", i));
    assert.deepEqual(
      [spoofed.status, JSON.parse(spoofed.text)],
      [403, { error: "location does not match token" }],
    );
  }
}

test("both tokens work during rotation and only the new one after the overlap", async () => {
  await overlap();
  await restartKeepsDeadline();
  await expiryCap();
  await repeatAndRevoke();
  await probeRoutes();
});
