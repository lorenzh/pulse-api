import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminConfigResponse,
  type CheckWithState,
  validateAdminConfigResponse,
  validateAdminConfigSummary,
} from "@lorenzh/pulse-contract";
import { StartupError } from "@lorenzh/pulse-kit";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const FILE_SECRET = "file-heartbeat-secret-0123456789";
const DB_SECRET = "db-heartbeat-secret-0123456789ab";

const FILE = {
  checks: [
    { id: "web", name: "Web", url: "https://web.example/", intervalMs: 60000 },
    { id: "fhb", name: "File HB", type: "heartbeat", period: 60000, secret: FILE_SECRET },
  ],
  components: [{ id: "site", name: "Site", checkIds: ["web"] }],
};

let dir: string;
let file: string;
let dbPath: string;
const running: RunningApi[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-fallback-"));
  file = join(dir, "checks.json");
  dbPath = join(dir, "pulse.db");
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
  for (const api of running.splice(0)) await api.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Started {
  base: string;
  api: RunningApi;
  lines: string[];
  admin(method: string, path: string, body?: unknown, ifMatch?: string): Promise<Response>;
  config(): Promise<{ view: AdminConfigResponse; etag: string }>;
}

async function start(now = NOW): Promise<Started> {
  const lines: string[] = [];
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: dbPath,
      PULSE_CHECKS_FILE: file,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: "0",
    },
    now: () => now,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    write: (_level, line) => lines.push(line),
    openDb: (path) => openDb(path),
  });
  running.push(api);
  const base = `http://127.0.0.1:${api.port}`;
  const admin: Started["admin"] = (method, path, body, ifMatch) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
        ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const config = async () => {
    const r = await admin("GET", "/admin/config");
    assert.equal(r.status, 200);
    const raw: unknown = await r.json();
    assert.ok(validateAdminConfigSummary(raw).ok, "the console summary validator accepts it");
    const v = validateAdminConfigResponse(raw);
    assert.ok(v.ok, v.ok ? "" : v.error);
    const etag = r.headers.get("etag");
    assert.ok(etag);
    return { view: v.value, etag };
  };
  return { base, api, lines, admin, config };
}

async function stop(s: Started): Promise<void> {
  running.splice(running.indexOf(s.api), 1);
  await s.api.close();
}

const ping = async (s: Started, id: string, secret: string): Promise<number> =>
  (await fetch(`${s.base}/heartbeat/${id}/${secret}`, { method: "POST" })).status;

const publicIds = async (s: Started): Promise<string[]> =>
  ((await (await fetch(`${s.base}/checks`)).json()) as CheckWithState[])
    .map((c) => c.id)
    .sort((a, b) => a.localeCompare(b));

function listening(lines: string[]): Record<string, unknown> {
  const line = lines.find((l) => l.includes('"msg":"listening"'));
  assert.ok(line, "a listening line");
  return JSON.parse(line) as Record<string, unknown>;
}

const hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Start once with the valid file and store one database http check and one heartbeat. */
async function seed(): Promise<{ revision: string; view: AdminConfigResponse }> {
  writeFileSync(file, JSON.stringify(FILE));
  const s = await start();
  let { etag } = await s.config();
  for (const body of [
    { id: "dweb", name: "DB Web", url: "https://db.example/", intervalMs: 60000 },
    { id: "dhb", name: "DB HB", type: "heartbeat", period: 60000, grace: 0, secret: DB_SECRET },
  ]) {
    const r = await s.admin("POST", "/admin/checks", body, etag);
    assert.equal(r.status, 201);
    etag = r.headers.get("etag") ?? "";
  }
  const { view, etag: revision } = await s.config();
  await stop(s);
  return { revision, view };
}

test("Check 3: a reopen keeps definitions, source, revision and both heartbeat credentials", async () => {
  const before = await seed();
  const s = await start(NOW + 60_000);
  const after = await s.config();
  assert.equal(after.etag, before.revision);
  assert.deepEqual(after.view, before.view);
  assert.deepEqual(
    after.view.checks.map((c) => [c.id, c.source]),
    [
      ["web", "file"],
      ["fhb", "file"],
      ["dweb", "database"],
      ["dhb", "database"],
    ],
  );
  assert.equal(after.view.file.lastAppliedAt, NOW, "the same file keeps its first apply time");
  assert.equal(await ping(s, "dhb", DB_SECRET), 204);
  assert.equal(await ping(s, "fhb", FILE_SECRET), 204);
  assert.equal(await ping(s, "dhb", FILE_SECRET), 401);
  const fields = listening(s.lines);
  assert.equal(fields.fileState, "ok");
  assert.equal(fields.databaseChecks, 2);
});

test("Check 3: a broken file starts from the snapshot, serves its checks and accepts its secret", async () => {
  const before = await seed();
  writeFileSync(file, '{"checks": [');
  const s = await start(NOW + 60_000);
  const { view, etag } = await s.config();
  assert.equal(view.file.state, "invalid");
  assert.equal(typeof view.file.message, "string");
  assert.ok(!(view.file.message ?? "").includes(dir), "the message has no path");
  assert.equal(view.file.lastAppliedAt, NOW);
  assert.equal(etag, before.revision, "the revision is that of the snapshot file");
  assert.deepEqual(view.checks, before.view.checks);
  assert.deepEqual(view.components, before.view.components);
  assert.deepEqual(await publicIds(s), ["dhb", "dweb", "fhb", "web"]);
  assert.equal(await ping(s, "fhb", FILE_SECRET), 204);
  assert.equal(await ping(s, "fhb", "wrong-secret-0123456789abcdef"), 401);
  assert.equal(await ping(s, "dhb", DB_SECRET), 204);
  const warn = s.lines.filter((l) => l.includes("config load rejected at start"));
  assert.equal(warn.length, 1);
  assert.ok(warn[0]?.includes("; using the checks file applied at 2026-10-28T12:00:00.000Z"));
  assert.ok(!warn[0]?.includes(dir), "the warn line has no path");
  const fields = listening(s.lines);
  assert.equal(fields.fileState, "invalid");
  assert.equal(fields.databaseChecks, 2);
});

test("a missing file with a snapshot starts unreadable; database checks survive", async () => {
  await seed();
  rmSync(file);
  const s = await start();
  const { view } = await s.config();
  assert.deepEqual(view.file, {
    state: "unreadable",
    message: "cannot read the file (ENOENT)",
    lastAppliedAt: NOW,
  });
  assert.deepEqual(await publicIds(s), ["dhb", "dweb", "fhb", "web"]);
  assert.equal(listening(s.lines).fileState, "unreadable");
});

test("a broken or missing file without a snapshot still fails the start", async () => {
  writeFileSync(file, '{"checks": [');
  await assert.rejects(start(), StartupError);
  rmSync(file);
  await assert.rejects(start(), (err: unknown) => {
    assert.ok(err instanceof StartupError);
    assert.match(err.message, /cannot read checks file/);
    return true;
  });
});

test("the snapshot holds the file heartbeat digest, never its secret", async () => {
  await seed();
  const db = openDb(dbPath);
  try {
    const row = db
      .query<{ json: string; rev: string; at: number }, []>(
        "SELECT file_snapshot_json AS json, file_revision AS rev, file_applied_at AS at FROM config_state",
      )
      .get();
    assert.ok(row);
    assert.ok(!row.json.includes(FILE_SECRET));
    assert.ok(row.json.includes(hex(FILE_SECRET)));
    assert.equal(row.rev, `sha256-${hex(JSON.stringify(FILE))}`);
    assert.equal(row.at, NOW);
  } finally {
    db.close();
  }
});
