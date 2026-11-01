import { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogLevel, StartupError } from "@lorenzh/pulse-kit";
import { openDb } from "./db.ts";
import { type StartDeps, startApi } from "./start.ts";

const NOW = Date.parse("2030-01-10T12:00:00Z");
const EU_1 = "probe-eu-one-0123456789abcdef";
const EU_2 = "probe-eu-two-0123456789abcdef";
const US = "probe-us-one-0123456789abcdef";
const OPS = "admin-ops-0123456789abcdef";
const ONCALL = "admin-oncall-0123456789abcdef";
const LATE = "probe-late-0123456789abcdef";
const FIXTURE = join(import.meta.dir, "..", "test", "fixtures", "pulse-v3.db");
const IGNORED = "PULSE_TOKENS_FILE ignored: tokens are stored in the database";

let dir = "";
let dbPath = "";
let checksFile = "";
let tokensFile = "";
let adminFile = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-token-import-"));
  dbPath = join(dir, "pulse.db");
  checksFile = join(dir, "checks.json");
  tokensFile = join(dir, "tokens.json");
  adminFile = join(dir, "admin-tokens.json");
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "c1", name: "C1", url: "https://x.invalid/", intervalMs: 1000 }],
    }),
  );
  writeProbeFile([
    { location: "eu", token: EU_1 },
    { location: "eu", token: EU_2 },
    { location: "us", token: US },
  ]);
  writeFileSync(
    adminFile,
    JSON.stringify({
      tokens: [
        { name: "ops", token: OPS },
        { name: "oncall", token: ONCALL },
      ],
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeProbeFile(tokens: { location: string; token: string }[]): void {
  writeFileSync(tokensFile, JSON.stringify({ tokens }));
}

interface Started {
  base: string;
  get: (path: string, token: string) => Promise<number>;
  lines: string[];
  close: () => Promise<void>;
}

async function boot(env: Record<string, string | undefined>): Promise<Started> {
  const lines: string[] = [];
  const deps: StartDeps = {
    env: { PORT: "0", PULSE_DB: dbPath, PULSE_CHECKS_FILE: checksFile, ...env },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level: LogLevel, line: string) => lines.push(line),
    openDb: (path) => openDb(path),
  };
  const api = await startApi(deps);
  const base = `http://127.0.0.1:${api.port}`;
  return {
    base,
    lines,
    get: async (path, token) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      await res.arrayBuffer();
      return res.status;
    },
    close: () => api.close(),
  };
}

const BOTH = () => ({ PULSE_TOKENS_FILE: tokensFile, PULSE_API_ADMIN_TOKENS_FILE: adminFile });

async function startFails(env: Record<string, string | undefined>): Promise<string> {
  try {
    const api = await boot(env);
    await api.close();
  } catch (err) {
    assert.ok(err instanceof StartupError, String(err));
    return err.message;
  }
  throw new Error("expected the start to fail");
}

function counts(): { tokens: number; bootstrap: number; imports: number } {
  const db = new Database(dbPath);
  try {
    const count = (sql: string): number => (db.query(sql).get() as { n: number }).n;
    return {
      tokens: count("SELECT COUNT(*) AS n FROM api_tokens"),
      bootstrap: count("SELECT COUNT(*) AS n FROM token_bootstrap"),
      imports: count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'token.import'"),
    };
  } finally {
    db.close();
  }
}

async function assertAllWork(api: Started): Promise<void> {
  for (const token of [EU_1, EU_2, US]) assert.equal(await api.get("/probe/checks", token), 200);
  for (const token of [OPS, ONCALL]) assert.equal(await api.get("/admin/config", token), 200);
}

test("upgrade from file tokens keeps existing tokens working", async () => {
  copyFileSync(FIXTURE, dbPath);
  const first = await boot(BOTH());
  try {
    await assertAllWork(first);
    assert.equal(await first.get("/admin/config", EU_1), 403);
  } finally {
    await first.close();
  }

  rmSync(tokensFile);
  rmSync(adminFile);
  const bare = await boot({});
  try {
    await assertAllWork(bare);
    const res = await fetch(`${bare.base}/manual-incidents`);
    const list = (await res.json()) as { title: string }[];
    assert.deepEqual(
      list.map((i) => i.title).toSorted((a, b) => a.localeCompare(b)),
      ["fixture one", "fixture two"],
    );
  } finally {
    await bare.close();
  }

  // Revoke `ops` while the api is stopped, then restart with both files mounted again.
  const db = new Database(dbPath);
  const revoked = db
    .query("UPDATE api_tokens SET revoked_at = ? WHERE name = 'ops' RETURNING id")
    .all(NOW) as { id: string }[];
  db.close();
  assert.equal(revoked.length, 1);
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: OPS }] }));
  writeProbeFile([
    { location: "eu", token: EU_1 },
    { location: "eu", token: EU_2 },
    { location: "us", token: US },
    { location: "late", token: LATE },
  ]);
  const again = await boot(BOTH());
  try {
    assert.equal(await again.get("/admin/config", OPS), 401);
    assert.equal(await again.get("/admin/config", ONCALL), 200);
    assert.equal(await again.get("/probe/checks", LATE), 401);
    assert.equal(await again.get("/probe/checks", EU_2), 200);
    assert.ok(again.lines.some((l) => l.includes(IGNORED)));
  } finally {
    await again.close();
  }
});

test("a malformed admin file fails the first start and rolls back the probe import", async () => {
  writeFileSync(
    adminFile,
    JSON.stringify({ tokens: [{ name: "ops", token: OPS }, { token: ONCALL }] }),
  );
  const message = await startFails(BOTH());
  assert.match(message, /tokens\[1\]\.name/);
  assert.deepEqual(counts(), { tokens: 0, bootstrap: 0, imports: 0 });
});

test("an admin token equal to a probe token fails the start", async () => {
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: US }] }));
  const message = await startFails(BOTH());
  assert.ok(
    message.includes("admin tokens[0] is also a probe token: use a separate token"),
    message,
  );
  assert.ok(!message.includes(US));
  assert.deepEqual(counts(), { tokens: 0, bootstrap: 0, imports: 0 });
});

test("a probe-only install bootstraps its admins on a later start", async () => {
  const probeOnly = await boot({ PULSE_TOKENS_FILE: tokensFile });
  try {
    assert.equal(await probeOnly.get("/admin/config", OPS), 404);
  } finally {
    await probeOnly.close();
  }
  const later = await boot(BOTH());
  try {
    assert.equal(await later.get("/admin/config", OPS), 200);
  } finally {
    await later.close();
  }
  assert.deepEqual(counts(), { tokens: 5, bootstrap: 2, imports: 5 });
});

/** Import both files, then restart with `prepare` applied to the two paths. */
async function restartAfterImport(prepare: (tokens: string, admin: string) => void): Promise<void> {
  const first = await boot(BOTH());
  await first.close();
  const tokens = join(dir, "later-tokens.json");
  const admin = join(dir, "later-admin.json");
  prepare(tokens, admin);
  const again = await boot({ PULSE_TOKENS_FILE: tokens, PULSE_API_ADMIN_TOKENS_FILE: admin });
  try {
    await assertAllWork(again);
  } finally {
    await again.close();
  }
}

test("after both imports, missing token files do not fail the start", async () => {
  await restartAfterImport(() => undefined);
});

test("after both imports, malformed token files are never read", async () => {
  let paths: string[] = [];
  await restartAfterImport((tokens, admin) => {
    paths = [tokens, admin];
    for (const path of paths) writeFileSync(path, "{not json");
  });
  for (const path of paths) assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("after both imports, directories in place of the token files are never opened", async () => {
  await restartAfterImport((tokens, admin) => {
    mkdirSync(tokens);
    mkdirSync(admin);
  });
});

test("a fresh database with a missing probe file fails the start with no bootstrap row", async () => {
  const missing = join(dir, "missing.json");
  const message = await startFails({ PULSE_TOKENS_FILE: missing });
  assert.ok(message.startsWith(`cannot read tokens file ${missing}`), message);
  assert.ok(message.endsWith(`(PULSE_TOKENS_FILE=${missing})`), message);
  assert.deepEqual(counts(), { tokens: 0, bootstrap: 0, imports: 0 });
});
