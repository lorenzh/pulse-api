import { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

// These tests run real processes: bun:sqlite is synchronous, so a writer in the test thread could
// not run while the backup copies. Waits are on process output and exit, never a fixed sleep.
const ENTRY = fileURLToPath(new URL("./backup-main.ts", import.meta.url));

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture, never requested over a network
const check: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000, timeoutMs: 500 };

function result(timestamp: number, status: "up" | "down"): Result {
  return {
    checkId: "c1",
    timestamp,
    status,
    statusCode: status === "up" ? 200 : 503,
    latencyMs: 5,
    reason: status === "down" ? "HTTP 503" : null,
    location: "default",
    attempts: 1,
  };
}

type Counts = { version: number; checks: number; results: number; incidents: number };

function countsOf(db: Database): Counts {
  const n = (table: string): number =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  return {
    version,
    checks: n("checks"),
    results: n("results"),
    incidents: n("incidents"),
  };
}

function integrityOf(db: Database): unknown {
  return (db.query("PRAGMA integrity_check").get() as { integrity_check: unknown }).integrity_check;
}

function runBackup(
  args: string[],
  source: string,
): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, [ENTRY, ...args], {
    env: { ...process.env, PULSE_DB: source },
    encoding: "utf8",
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-backup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tempFilesIn = (path: string): string[] =>
  readdirSync(path).filter((f) => f.includes(".tmp-"));

test("backup at a quiet point: an intact copy with the source's counts and one report line", () => {
  const source = join(dir, "pulse.db");
  const db = openDb(source);
  try {
    const s = createService(db);
    s.upsertChecks([check]);
    s.ingest(result(1000, "up"));
    s.ingest(result(2000, "down"));
    s.ingest(result(3000, "down"));
    s.ingest(result(4000, "down"));
    const expected = countsOf(db);
    assert.ok(expected.incidents >= 1);

    // A quote in the target name must not break the SQL.
    const target = join(dir, "it's.db");
    const run = runBackup([target], source);
    assert.equal(run.err, "");
    assert.equal(run.status, 0);
    assert.equal(
      run.out,
      `backup ${target}: schema version ${expected.version}, checks ${expected.checks}, results ${expected.results}, incidents ${expected.incidents}\n`,
    );

    const copy = openDb(target);
    assert.equal(integrityOf(copy), "ok");
    assert.deepEqual(countsOf(copy), expected);
    copy.close();
    assert.deepEqual(tempFilesIn(dir), []);
  } finally {
    db.close();
  }
});

const WRITER = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]);
db.run("PRAGMA busy_timeout = 5000");
const insert = db.prepare(
  "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('c1', ?, 'up', 5)",
);
for (let t = 10_000; ; t += 1) {
  db.transaction(() => insert.run(t))();
  console.log(t);
  await Bun.sleep(1);
}
`;

async function waitForLines(stream: ReadableStream<Uint8Array>, count: number): Promise<void> {
  const decoder = new TextDecoder();
  let seen = 0;
  for await (const chunk of stream) {
    seen += decoder.decode(chunk).split("\n").length - 1;
    if (seen >= count) return;
  }
  throw new Error(`writer stopped after ${seen} lines`);
}

test("backup under load: an intact snapshot between the counts before and after", async () => {
  const source = join(dir, "pulse.db");
  const seed = openDb(source);
  createService(seed).upsertChecks([check]);
  seed.close();
  const script = join(dir, "writer.ts");
  writeFileSync(script, WRITER);
  const writer = Bun.spawn([process.execPath, script, source], { stdout: "pipe", stderr: "pipe" });
  const reader = new Database(source, { readonly: true });
  reader.run("PRAGMA busy_timeout = 5000");
  try {
    await waitForLines(writer.stdout, 20);
    const before = countsOf(reader).results;
    const target = join(dir, "load.db");
    const run = runBackup([target], source);
    writer.kill();
    await writer.exited;
    const after = countsOf(reader).results;

    assert.equal(run.err, "");
    assert.equal(run.status, 0);
    const copy = new Database(target, { readonly: true });
    assert.equal(integrityOf(copy), "ok");
    const inCopy = countsOf(copy).results;
    copy.close();
    assert.ok(before >= 20 && before <= inCopy && inCopy <= after, `${before} ${inCopy} ${after}`);
    assert.match(run.out, new RegExp(`, results ${inCopy}, `));
  } finally {
    writer.kill();
    reader.close();
  }
});

test("backup refuses bad input: exit 2 for usage and an existing target, 1 for missing paths", () => {
  const source = join(dir, "pulse.db");
  openDb(source).close();
  const existing = join(dir, "old.db");
  writeFileSync(existing, "keep me");

  const taken = runBackup([existing], source);
  assert.equal(taken.status, 2);
  assert.match(taken.err, /^pulse-api backup: target .*old\.db exists/);
  assert.equal(readFileSync(existing, "utf8"), "keep me");

  const none = runBackup([], source);
  assert.equal(none.status, 2);
  assert.equal(none.err, "pulse-api backup: usage: bun run backup <target-file>\n");

  const missing = join(dir, "missing.db");
  const noSource = runBackup([join(dir, "a.db")], missing);
  assert.equal(noSource.status, 1);
  assert.match(noSource.err, /^pulse-api backup: source \(PULSE_DB\) .*missing\.db does not exist/);
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(join(dir, "a.db")), false);

  const noDir = runBackup([join(dir, "nope", "b.db")], source);
  assert.equal(noDir.status, 1);
  assert.match(noDir.err, /^pulse-api backup: target directory .*nope does not exist/);
  assert.equal(existsSync(join(dir, "nope")), false);

  for (const run of [taken, none, noSource, noDir]) {
    assert.equal(run.out, "");
    assert.doesNotMatch(run.err, /\n./);
  }
  assert.deepEqual(tempFilesIn(dir), []);
});
