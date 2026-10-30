import { Database } from "bun:sqlite";
import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecksResponse } from "@lorenzh/pulse-contract";
import { type LogLevel, StartupError } from "@lorenzh/pulse-kit";
import { openDb } from "./db.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { type StartDeps, startApi } from "./start.ts";

const TOKEN = "test-token-east-0123456789abcdef";
const SECRET_URL = "https://user:hunter2@internal.example/path";
const KEYWORD = "s3cret-keyword";
const NOW = Date.parse("2026-10-28T12:00:00Z");

let dir: string;
let checksFile: string;
let tokensFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-start-"));
  mkdirSync(dir, { recursive: true });
  checksFile = join(dir, "checks.json");
  tokensFile = join(dir, "tokens.json");
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "c1", name: "C1", url: SECRET_URL, intervalMs: 1000, keyword: KEYWORD }],
    }),
  );
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ location: "eu", token: TOKEN }] }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function deps(env: Record<string, string>, extra: Partial<StartDeps> = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const base: StartDeps = {
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "t.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_TOKENS_FILE: tokensFile,
      ...env,
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (level, line) => lines.push({ line, level }),
    openDb: (path) => openDb(path),
    ...extra,
  };
  return { base, lines };
}

async function startupMessage(env: Record<string, string>): Promise<string> {
  const { base } = deps(env, { openDb: () => openDb(":memory:") });
  try {
    await startApi(base);
  } catch (err) {
    assert.ok(err instanceof StartupError, `expected StartupError, got ${String(err)}`);
    return err.message;
  }
  throw new Error("expected a startup error");
}

test("startup errors are one-line StartupErrors that name the setting", async () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.match(await startupMessage({ PULSE_RETENTION_DAYS: "abc" }), /PULSE_RETENTION_DAYS/);
  assert.match(await startupMessage({ PULSE_LOG_LEVEL: "loud" }), /PULSE_LOG_LEVEL/);
  assert.match(await startupMessage({ PORT: "99999" }), /PORT/);
  assert.match(await startupMessage({ PORT: "x" }), /PORT/);
  assert.match(await startupMessage({ PULSE_CHECKS_FILE: bad }), /bad\.json/);
  assert.match(await startupMessage({ PULSE_CHECKS_FILE: join(dir, "missing") }), /missing/);
  assert.match(await startupMessage({ PULSE_TOKENS_FILE: bad }), /bad\.json/);
  const msg = await startupMessage({ PULSE_TOKENS_FILE: join(dir, "missing.json") });
  assert.doesNotMatch(msg, /\n/);
});

test("an unknown key in the checks file is a startup error naming file, key and path", async () => {
  const typo = join(dir, "typo.json");
  writeFileSync(
    typo,
    JSON.stringify({
      checks: [
        { id: "a", name: "A", url: "https://a.example/", intervalMs: 1000 },
        { id: "b", name: "B", url: "https://b.example/", intervalMs: 1000, keywrod: "x" },
      ],
    }),
  );
  const msg = await startupMessage({ PULSE_CHECKS_FILE: typo });
  assert.equal(msg, `${typo}: unknown key "keywrod" in checks[1]`);
});

test("a database that cannot be opened is a startup error", async () => {
  const { base } = deps(
    {},
    {
      openDb: () => {
        throw new Error("unable to open");
      },
    },
  );
  await assert.rejects(startApi(base), (err: Error) => {
    assert.ok(err instanceof StartupError);
    assert.match(err.message, /PULSE_DB/);
    return true;
  });
});

test("a port in use is a startup error and the database is closed", async () => {
  const first = await startApi(deps({}).base);
  let db: Database | undefined;
  const second = deps(
    { PORT: String(first.port) },
    {
      openDb: (path) => {
        db = openDb(path);
        return db;
      },
    },
  );
  try {
    await assert.rejects(startApi(second.base), (err: Error) => {
      assert.ok(err instanceof StartupError);
      assert.match(err.message, /PORT/);
      return true;
    });
    assert.throws(() => db?.prepare("SELECT 1"));
  } finally {
    await first.close();
  }
});

test("healthz answers without a checks query, then 503 while shutting down; shutdown closes the db", async () => {
  let db: Database | undefined;
  const { base, lines } = deps(
    {},
    {
      openDb: (path) => {
        db = openDb(path);
        return db;
      },
    },
  );
  const api = await startApi(base);
  const url = `http://127.0.0.1:${api.port}`;
  const ok = await fetch(`${url}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok\n");
  assert.match(ok.headers.get("content-type") ?? "", /^text\/plain/);

  const first = api.close();
  const second = api.close();
  assert.equal(first, second);
  await first;
  assert.throws(() => db?.prepare("SELECT 1"));
  const levels = lines.map(
    (l) => JSON.parse(l.line) as { time: string; level: string; msg: string },
  );
  assert.ok(levels.every((l) => !Number.isNaN(Date.parse(l.time)) && l.level.length > 0));
  assert.equal(levels.at(-1)?.msg, "stopped");
});

test("healthz does not read the checks table", async () => {
  let db: Database | undefined;
  const { base } = deps(
    {},
    {
      openDb: (path) => {
        db = openDb(path);
        return db;
      },
    },
  );
  const api = await startApi(base);
  try {
    // Dropping the table would make any query on it fail.
    db?.run("ALTER TABLE checks RENAME TO checks_gone");
    const res = await fetch(`http://127.0.0.1:${api.port}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    db?.run("ALTER TABLE checks_gone RENAME TO checks");
    await api.close();
  }
});

test("shutdown during an open connection hits the bound, warns and still closes", async () => {
  let release: () => void = () => undefined;
  let db: Database | undefined;
  const { base, lines } = deps(
    {},
    {
      sleep: () => new Promise<void>((r) => (release = r)),
      openDb: (path) => {
        db = openDb(path);
        return db;
      },
    },
  );
  const api = await startApi(base);
  const { connect } = await import("node:net");
  const socket = connect(api.port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", r));
  // A request that never finishes keeps the connection busy.
  socket.write("POST /results HTTP/1.1\r\nhost: x\r\ncontent-length: 10\r\n\r\n");
  await new Promise((r) => setImmediate(r));
  const closing = api.close();
  release();
  await closing;
  assert.ok(lines.some((l) => l.level === "warn" && l.line.includes("shutdown bound")));
  assert.throws(() => db?.prepare("SELECT 1"));
  socket.destroy();
});

test("metrics: series appear, and no url, keyword or token", async () => {
  const api = await startApi(deps({}).base);
  const url = `http://127.0.0.1:${api.port}`;
  try {
    const send = async (offset: number, status: "up" | "down", latencyMs: number) => {
      const res = await fetch(`${url}/results`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          checkId: "c1",
          timestamp: NOW + offset,
          status,
          statusCode: status === "up" ? 200 : 500,
          latencyMs,
          reason: status === "up" ? null : `failed ${SECRET_URL} ${KEYWORD}`,
          location: "eu",
        }),
      });
      assert.equal(res.status, 204);
    };
    // Three downs open an incident; an up resolves it.
    for (const offset of [0, 1, 2]) await send(offset, "down", 300);
    await send(3, "up", 20);
    const checks = (await (await fetch(`${url}/checks`)).json()) as ChecksResponse;
    assert.equal(checks.length, 1);
    await fetch(`${url}/checks/c1/results`);
    await fetch(`${url}/nope/secret-id`);

    const res = await fetch(`${url}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const text = await res.text();
    assert.match(text, /^pulse_up 1$/m);
    assert.match(text, /^pulse_api_check_state\{check="c1",state="up"\} 1$/m);
    assert.match(text, /^pulse_api_check_state\{check="c1",state="down"\} 0$/m);
    assert.match(text, /^pulse_api_results_ingested_total\{location="eu"\} 4$/m);
    assert.match(text, /^pulse_api_result_latency_seconds_bucket\{check="c1",le="0.05"\} 1$/m);
    assert.match(text, /^pulse_api_result_latency_seconds_bucket\{check="c1",le="0.5"\} 4$/m);
    assert.match(text, /^pulse_api_result_latency_seconds_bucket\{check="c1",le="\+Inf"\} 4$/m);
    assert.match(text, /^pulse_api_result_latency_seconds_count\{check="c1"\} 4$/m);
    assert.match(text, /^pulse_api_incidents_opened_total 1$/m);
    assert.match(text, /^pulse_api_incidents_resolved_total 1$/m);
    assert.match(text, /^pulse_api_http_requests_total\{route="\/results",code="204"\} 4$/m);
    assert.match(text, /route="\/checks\/:id\/results",code="200"/);
    assert.match(text, /route="unmatched",code="404"/);
    for (const secret of [SECRET_URL, "hunter2", "internal.example", KEYWORD, TOKEN, "secret-id"]) {
      assert.ok(!text.includes(secret), `metrics leak ${secret}`);
    }
  } finally {
    await api.close();
  }
});

test("heartbeat e2e: the started api goes down without a ping and a ping resolves it", async () => {
  const file = join(dir, "hb-checks.json");
  const secret = "hb-secret-0123456789abcdef";
  writeFileSync(
    file,
    JSON.stringify({
      checks: [{ id: "job", name: "Job", type: "heartbeat", period: 2000, grace: 1000, secret }],
    }),
  );
  let now = NOW;
  const timers: (() => void)[] = [];
  const { base, lines } = deps(
    { PULSE_CHECKS_FILE: file, PULSE_DB: join(dir, "hb.db") },
    {
      now: () => now,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
    },
  );
  const api = await startApi(base);
  try {
    const url = `http://127.0.0.1:${api.port}`;
    const checks = async (): Promise<ChecksResponse> =>
      (await (await fetch(`${url}/checks`)).json()) as ChecksResponse;
    // The first tick starts the wait; the second comes after period + grace.
    for (const fn of timers.splice(0)) fn();
    now += 3001;
    for (const fn of timers.splice(0)) fn();
    assert.equal((await checks())[0]?.state, "down");
    const open = await (await fetch(`${url}/incidents?status=open`)).json();
    assert.equal((open as unknown[]).length, 1);
    const ping = await fetch(`${url}/heartbeat/job`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(ping.status, 204);
    assert.equal((await checks())[0]?.state, "up");
    const resolved = await (await fetch(`${url}/incidents?status=open`)).json();
    assert.equal((resolved as unknown[]).length, 0);
    assert.equal(
      lines.some((l) => l.line.includes(secret)),
      false,
    );
  } finally {
    await api.close();
  }
});

test("shutdown during a retention run waits for the run, then closes: no write after close", async () => {
  const dbFile = join(dir, "race.db");
  let db: Database | undefined;
  const timers: { fn: () => void; ms: number }[] = [];
  const gates: (() => void)[] = [];
  const { base, lines } = deps(
    { PULSE_DB: dbFile },
    {
      retentionIntervalMs: 10,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      // sleep(0) is the pause between retention batches; the shutdown bound never fires.
      sleep: (ms) =>
        ms === 0
          ? new Promise<void>((resolve) => gates.push(resolve))
          : new Promise<void>(() => undefined),
      openDb: (path) => {
        db = openDb(path);
        return db;
      },
    },
  );
  const api = await startApi(base);
  assert.ok(db);
  // 2500 expired rows plus one fresh row that is kept as the newest of its location.
  const insert = db.prepare(
    "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES ('c1', ?, 'up', 1, 'eu')",
  );
  db.run("BEGIN");
  for (let i = 0; i < 2500; i++) insert.run(NOW - 200 * 86_400_000 + i);
  insert.run(NOW);
  db.run("COMMIT");
  const retentionTimers = (): { fn: () => void; ms: number }[] => timers.filter((t) => t.ms === 10);
  const start = retentionTimers()[0];
  assert.ok(start, "the first run scheduled the second");
  start.fn(); // second run: first batch deleted, now waiting between batches
  const closing = api.close();
  let isClosed = false;
  void closing.then(() => {
    isClosed = true;
  });
  for (let i = 0; i < 10 && !isClosed; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    const isDbOpen = ((): boolean => {
      try {
        db.prepare("SELECT 1");
        return true;
      } catch {
        // A closed bun:sqlite database throws on prepare.
        return false;
      }
    })();
    assert.equal(isDbOpen, !isClosed || false);
    gates.shift()?.();
  }
  await closing;
  const text = lines.map((l) => l.line).join("\n");
  assert.doesNotMatch(text, /not open/);
  assert.doesNotMatch(text, /retention failed/);
  assert.match(text, /retention: deleted 2500 results/);
  assert.equal(retentionTimers().length, 1, "no run was scheduled after stop");
});

test("a token validation error names the tokens file path and the setting", async () => {
  const bad = join(dir, "short-tokens.json");
  writeFileSync(bad, JSON.stringify({ tokens: [{ location: "eu", token: "short" }] }));
  const message = await startupMessage({ PULSE_TOKENS_FILE: bad });
  assert.ok(message.includes(bad), message);
  assert.ok(message.includes("PULSE_TOKENS_FILE"), message);
  assert.ok(!message.includes('"short"'), message);
});

const ADMIN_TOKEN = "admin-token-0123456789abcdef";

test("admin tokens: the file enables writes; the token never reaches the logs", async () => {
  const adminFile = join(dir, "admin.json");
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN_TOKEN }] }));
  const { base, lines } = deps({ PULSE_API_ADMIN_TOKENS_FILE: adminFile });
  const api = await startApi(base);
  try {
    const url = `http://127.0.0.1:${api.port}/manual-incidents`;
    const refused = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(refused.status, 401);
    const created = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "t", impact: "none", componentIds: [], message: "m" }),
    });
    assert.equal(created.status, 201);
    const metrics = await (await fetch(`http://127.0.0.1:${api.port}/metrics`)).text();
    assert.match(metrics, /^pulse_api_manual_incidents_created_total 1$/m);
  } finally {
    await api.close();
  }
  assert.ok(!lines.some((l) => l.line.includes(ADMIN_TOKEN)));
  assert.ok(lines.some((l) => l.line.includes('"manualIncidents":"writable"')));
});

test("without the admin tokens setting the writes answer 404", async () => {
  const { base } = deps({});
  const api = await startApi(base);
  try {
    const r = await fetch(`http://127.0.0.1:${api.port}/manual-incidents`, { method: "POST" });
    assert.equal(r.status, 404);
  } finally {
    await api.close();
  }
});

test("admin token startup errors name the setting and never print a token", async () => {
  const overlap = join(dir, "admin-overlap.json");
  writeFileSync(overlap, JSON.stringify({ tokens: [{ name: "ops", token: TOKEN }] }));
  const message = await startupMessage({ PULSE_API_ADMIN_TOKENS_FILE: overlap });
  assert.match(message, /also a probe token.*PULSE_API_ADMIN_TOKENS_FILE=/);
  assert.ok(!message.includes(TOKEN));
  const missing = await startupMessage({ PULSE_API_ADMIN_TOKENS_FILE: join(dir, "nope.json") });
  assert.match(missing, /cannot read admin tokens file/);
  const example = join(dir, "admin-example.json");
  writeFileSync(
    example,
    JSON.stringify({ tokens: [{ name: "ops", token: "replace-with-x-0123456789" }] }),
  );
  assert.match(await startupMessage({ PULSE_API_ADMIN_TOKENS_FILE: example }), /placeholder/);
});

/** Start the API on a database that holds one manual incident; read the list and the item. */
async function readStoredManualIncident(
  env: Record<string, string>,
): Promise<{ list: { id: number }[]; item: number; id: number }> {
  const db = openDb(":memory:");
  const store = createManualIncidentStore(db, { now: () => NOW, componentIds: new Set() });
  const stored = store.create({ title: "t", impact: "none", componentIds: [], message: "m" });
  assert.equal(store.list("all").length, 1);
  const { base } = deps(env, { openDb: () => db });
  const api = await startApi(base);
  try {
    const r = await fetch(`http://127.0.0.1:${api.port}/manual-incidents`);
    assert.equal(r.status, 200);
    const item = await fetch(`http://127.0.0.1:${api.port}/manual-incidents/${stored.id}`);
    return { list: (await r.json()) as { id: number }[], item: item.status, id: stored.id };
  } finally {
    await api.close();
  }
}

test("without the admin tokens setting the reads are empty although the database holds incidents", async () => {
  const result = await readStoredManualIncident({});
  assert.deepEqual(result.list, []);
  assert.equal(result.item, 404);
});

test("with the admin tokens setting the reads list the stored incidents", async () => {
  const adminFile = join(dir, "admin-read.json");
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN_TOKEN }] }));
  const result = await readStoredManualIncident({ PULSE_API_ADMIN_TOKENS_FILE: adminFile });
  assert.deepEqual(
    result.list.map((i) => i.id),
    [result.id],
  );
  assert.equal(result.item, 200);
});

test("a database from a newer program is a startup error", async () => {
  const path = join(dir, "newer.db");
  const raw = new Database(path);
  raw.run("PRAGMA user_version = 99");
  raw.close();
  const { base } = deps({ PULSE_DB: path });
  await assert.rejects(
    startApi(base),
    (err: unknown) =>
      err instanceof StartupError &&
      err.message.includes("database schema version 99 is newer than this program supports"),
  );
});
