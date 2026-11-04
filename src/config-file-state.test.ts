import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminConfigResponse,
  type AdminFileStatus,
  validateAdminConfigResponse,
  validateAdminConfigSummary,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0123456789abcdef";
const T0 = Date.parse("2026-10-28T12:00:00Z");
const RELOAD_MS = 2000;
const FAIL_UPSERT =
  "CREATE TEMP TRIGGER fail_upsert BEFORE INSERT ON checks BEGIN SELECT RAISE(ABORT, 'locked'); END";

const FILE_A = {
  checks: [{ id: "web", name: "Web", url: "https://web.example/", intervalMs: 60000 }],
};
const FILE_B = {
  checks: [
    ...FILE_A.checks,
    { id: "api", name: "Api", url: "https://api.example/", intervalMs: 60000 },
  ],
};
const BROKEN = '{"checks": [';

let dir: string;
let file: string;
const running: RunningApi[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-file-state-"));
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
  for (const api of running.splice(0)) await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const hex = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Harness {
  clock: { now: number };
  warnings(): string[];
  poll(): void;
  hup(): void;
  db(): ReturnType<typeof openDb>;
  admin(method: string, path: string, body?: unknown, ifMatch?: string): Promise<Response>;
  config(): Promise<{ view: AdminConfigResponse; etag: string }>;
}

async function boot(content: string): Promise<Harness> {
  writeFileSync(file, content);
  const clock = { now: T0 };
  const lines: { level: string; line: string }[] = [];
  const timers: (() => void)[] = [];
  const signals: (() => void)[] = [];
  let db: ReturnType<typeof openDb> | undefined;
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "pulse.db"),
      PULSE_CHECKS_FILE: file,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
      PULSE_CHECKS_RELOAD_INTERVAL_MS: String(RELOAD_MS),
    },
    now: () => clock.now,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: (fn, ms) => {
      if (ms === RELOAD_MS) timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => undefined,
    write: (level, line) => lines.push({ level, line }),
    openDb: (path) => {
      db = openDb(path);
      return db;
    },
    onSignal: (_signal, handler) => {
      signals.push(handler);
      return () => undefined;
    },
  });
  running.push(api);
  const base = `http://127.0.0.1:${api.port}`;
  const admin: Harness["admin"] = (method, path, body, ifMatch) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        "content-type": "application/json",
        ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    clock,
    warnings: () => lines.filter((l) => l.level === "warn").map((l) => l.line),
    poll() {
      const fn = timers.shift();
      assert.ok(fn, "a reload poll is scheduled");
      fn();
    },
    hup() {
      for (const handler of signals) handler();
    },
    db() {
      assert.ok(db);
      return db;
    },
    admin,
    async config() {
      const r = await admin("GET", "/admin/config");
      assert.equal(r.status, 200);
      const raw: unknown = await r.json();
      assert.ok(validateAdminConfigSummary(raw).ok, "the console summary validator accepts it");
      const v = validateAdminConfigResponse(raw);
      assert.ok(v.ok, v.ok ? "" : v.error);
      const etag = r.headers.get("etag");
      assert.ok(etag);
      return { view: v.value, etag };
    },
  };
}

const fileStatus = async (h: Harness): Promise<AdminFileStatus> => (await h.config()).view.file;

function snapshotRevision(h: Harness): string | null {
  const row = h
    .db()
    .query<{ rev: string | null }, []>("SELECT file_revision AS rev FROM config_state")
    .get();
  return row?.rev ?? null;
}

test("the four file states are distinct, only ok has a null message, and a fix applies again", async () => {
  const h = await boot(JSON.stringify(FILE_A));
  const { etag } = await h.config();
  assert.deepEqual(await fileStatus(h), { state: "ok", message: null, lastAppliedAt: T0 });

  h.clock.now = T0 + 1000;
  writeFileSync(file, BROKEN);
  h.poll();
  assert.deepEqual(await fileStatus(h), {
    state: "invalid",
    message: "checks file is not valid JSON",
    lastAppliedAt: T0,
  });
  assert.equal((await h.config()).etag, etag, "a rejected file keeps the revision");

  rmSync(file);
  h.poll();
  assert.deepEqual(await fileStatus(h), {
    state: "unreadable",
    message: "cannot read the file (ENOENT)",
    lastAppliedAt: T0,
  });

  h.db().run(FAIL_UPSERT);
  writeFileSync(file, JSON.stringify(FILE_B));
  h.poll();
  const pending = await fileStatus(h);
  assert.equal(pending.state, "written-not-applied");
  assert.match(pending.message ?? "", /^cannot apply the configuration: \w+/);
  assert.equal(pending.lastAppliedAt, T0);

  h.db().run("DROP TRIGGER fail_upsert");
  h.clock.now = T0 + 5000;
  h.poll();
  assert.deepEqual(await fileStatus(h), { state: "ok", message: null, lastAppliedAt: T0 + 5000 });
  assert.deepEqual(
    (await h.config()).view.checks.map((c) => c.id),
    ["web", "api"],
  );
});

test("the same bad file is logged once, while a failed apply is retried at every poll", async () => {
  const h = await boot(JSON.stringify(FILE_A));
  writeFileSync(file, BROKEN);
  h.hup();
  h.hup();
  h.hup();
  assert.equal(h.warnings().filter((l) => l.includes("config reload rejected")).length, 1);

  h.db().run(FAIL_UPSERT);
  writeFileSync(file, JSON.stringify(FILE_B));
  h.poll();
  h.poll();
  h.poll();
  assert.equal(h.warnings().filter((l) => l.includes("config reload failed")).length, 1);
  h.db().run("DROP TRIGGER fail_upsert");
  h.poll();
  assert.equal((await fileStatus(h)).state, "ok", "the retry of the next poll applies it");
});

test("a database write keeps lastAppliedAt and the broken file bytes", async () => {
  const h = await boot(JSON.stringify(FILE_A));
  writeFileSync(file, BROKEN);
  h.poll();
  const { etag } = await h.config();
  h.clock.now = T0 + 9000;
  const r = await h.admin(
    "POST",
    "/admin/checks",
    { id: "dweb", name: "DB", url: "https://db.example/", intervalMs: 60000 },
    etag,
  );
  assert.equal(r.status, 201);
  assert.equal(readFileSync(file, "utf8"), BROKEN);
  const { view } = await h.config();
  assert.deepEqual(view.file, {
    state: "invalid",
    message: "checks file is not valid JSON",
    lastAppliedAt: T0,
  });
  assert.deepEqual(
    view.checks.map((c) => [c.id, c.source]),
    [
      ["web", "file"],
      ["dweb", "database"],
    ],
  );
});

test("the snapshot is written with the file reconcile; a rolled-back reconcile keeps the old one", async () => {
  const a = JSON.stringify(FILE_A);
  const b = JSON.stringify(FILE_B);
  const h = await boot(a);
  assert.equal(snapshotRevision(h), `sha256-${hex(a)}`);
  h.db().run(FAIL_UPSERT);
  writeFileSync(file, b);
  h.poll();
  assert.equal(snapshotRevision(h), `sha256-${hex(a)}`, "the failed reconcile left it");
  h.db().run("DROP TRIGGER fail_upsert");
  h.poll();
  assert.equal(snapshotRevision(h), `sha256-${hex(b)}`);
});
