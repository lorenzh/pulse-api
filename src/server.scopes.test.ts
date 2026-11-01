import { Database } from "bun:sqlite";
import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenScope } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";
import { openTokenStore } from "./token-import.ts";

const NOW = Date.parse("2030-01-10T12:00:00Z");
const PROBE = "probe-scopes-0123456789abcdef";
const ADMIN = "admin-scopes-0123456789abcdef";
const UNKNOWN = "unknown-scopes-0123456789abcdef";
const ACTOR = { tokenId: null, name: "test" };

let dir = "";
let checksFile = "";
let tokensFile = "";
let api: RunningApi;
let base = "";
const secrets = new Map<string, string>();

function deps(dbPath: string, env: Record<string, string>): StartDeps {
  return {
    env: { PORT: "0", PULSE_DB: dbPath, PULSE_CHECKS_FILE: checksFile, ...env },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  };
}

const SCOPED: Record<string, TokenScope[]> = {
  "read,checks": ["read", "checks"],
  read: ["read"],
  admin: ["admin"],
  "admin,checks": ["admin", "checks"],
  incidents: ["incidents"],
  revoked: ["read", "checks"],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-scopes-"));
  checksFile = join(dir, "checks.json");
  tokensFile = join(dir, "tokens.json");
  writeFileSync(
    checksFile,
    `${JSON.stringify({ checks: [{ id: "x", name: "X", url: "https://x.invalid/", intervalMs: 1000 }] }, null, 2)}\n`,
  );
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }));
  const dbPath = join(dir, "pulse.db");
  const db = openDb(dbPath);
  const store = openTokenStore(
    { db, now: () => NOW },
    { probe: [{ location: "eu", token: PROBE }], admin: [{ name: "ops", token: ADMIN }] },
  );
  for (const [name, scopes] of Object.entries(SCOPED)) {
    const made = store.create(
      { name, scopes, location: null, expiresAt: null, source: "api" },
      ACTOR,
    );
    secrets.set(name, made.secret);
    if (name === "revoked") store.revoke(made.token.id, ACTOR);
  }
  db.close();
  api = await startApi(deps(dbPath, { PULSE_TOKENS_FILE: tokensFile }));
  base = `http://127.0.0.1:${api.port}`;
});
afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function secretOf(name: string): string {
  if (name === "probe") return PROBE;
  if (name === "unknown") return UNKNOWN;
  if (name === "legacy-admin") return ADMIN;
  const secret = secrets.get(name);
  if (secret === undefined) throw new Error(`no token ${name}`);
  return secret;
}

async function call(
  method: string,
  path: string,
  token: string,
  extra: { body?: unknown; ifMatch?: string; host?: string } = {},
): Promise<{ status: number; text: string; etag: string | null }> {
  const res = await fetch(`${extra.host ?? base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(extra.ifMatch === undefined ? {} : { "if-match": extra.ifMatch }),
      ...(extra.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
  });
  return { status: res.status, text: await res.text(), etag: res.headers.get("etag") };
}

const NEW_CHECK = { id: "y", name: "Y", url: "https://y.invalid/", intervalMs: 1000 };
const NEW_INCIDENT = { title: "t", impact: "none", componentIds: [], message: "m" };

function auditCount(): number {
  const db = new Database(join(dir, "pulse.db"), { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test("a token without admin cannot write checks", async () => {
  const view = await call("GET", "/admin/config", ADMIN);
  assert.equal(view.status, 200);
  const before = readFileSync(checksFile);
  const audits = auditCount();
  const r = await call("POST", "/admin/checks", secretOf("read,checks"), {
    body: NEW_CHECK,
    ifMatch: view.etag ?? "",
  });
  assert.equal(r.status, 403);
  assert.deepEqual(JSON.parse(r.text), { error: "forbidden" });
  assert.deepEqual(readFileSync(checksFile), before);
  assert.equal(auditCount(), audits);
  assert.equal((await call("GET", "/admin/config", ADMIN)).etag, view.etag);
});

test("the D1 matrix on the existing routes", async () => {
  const etag = (await call("GET", "/admin/config", ADMIN)).etag ?? "";
  const rows: [string, string, string, number, unknown?][] = [
    ["read,checks", "POST", "/admin/checks", 403, NEW_CHECK],
    ["read", "PUT", "/admin/checks/x", 403, { ...NEW_CHECK, id: "x" }],
    ["admin", "POST", "/admin/checks", 403, NEW_CHECK],
    ["admin,checks", "POST", "/manual-incidents", 403, NEW_INCIDENT],
    ["admin,checks", "GET", "/probe/checks", 403],
    ["admin,checks", "POST", "/results", 403, { checkId: "x" }],
    ["incidents", "GET", "/admin/config", 403],
    ["admin,checks", "GET", "/admin/config", 200],
    ["read", "GET", "/admin/config", 200],
    ["probe", "POST", "/manual-incidents", 403, NEW_INCIDENT],
    ["probe", "GET", "/admin/config", 403],
    ["probe", "GET", "/probe/checks", 200],
    ["legacy-admin", "GET", "/probe/checks", 403],
    ["revoked", "GET", "/admin/config", 401],
    ["unknown", "GET", "/admin/config", 401],
  ];
  for (const [name, method, path, status, body] of rows) {
    const r = await call(method, path, secretOf(name), {
      ifMatch: etag,
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(r.status, status, `${name} ${method} ${path}`);
  }
});

test("a revoked token answers 401 with the same body as an unknown one", async () => {
  const revoked = await call("GET", "/admin/config", secretOf("revoked"));
  const unknown = await call("GET", "/admin/config", UNKNOWN);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.text, unknown.text);
  assert.deepEqual(JSON.parse(revoked.text), { error: "unauthorized" });
});

test("admin not bootstrapped answers 404 before 401", async () => {
  const probeOnly = await startApi(
    deps(join(dir, "probe-only.db"), { PULSE_TOKENS_FILE: tokensFile }),
  );
  try {
    const host = `http://127.0.0.1:${probeOnly.port}`;
    assert.equal((await call("GET", "/admin/config", UNKNOWN, { host })).status, 404);
    assert.equal((await call("POST", "/manual-incidents", PROBE, { host })).status, 404);
  } finally {
    await probeOnly.close();
  }
});
