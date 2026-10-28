import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { HttpCheck } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

test("service: retry settings are stored, served and updated by upsert", () => {
  const s = createService(openDb(":memory:"));
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
  const c = { id: "c", name: "C", url: "http://x/", intervalMs: 60000 };
  s.upsertChecks([{ ...c, retries: 2, retryDelayMs: 250 }]);
  let got = s.listChecks()[0] as HttpCheck;
  assert.deepEqual([(got as HttpCheck).retries, (got as HttpCheck).retryDelayMs], [2, 250]);
  s.upsertChecks([{ ...c, retries: 0, retryDelayMs: 1000 }]);
  got = s.listChecks()[0] as HttpCheck;
  assert.deepEqual([(got as HttpCheck).retries, (got as HttpCheck).retryDelayMs], [0, 1000]);
});

test("db: an old database migrates and reads attempts as 1, retries as 0", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, timeout_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_down INTEGER NOT NULL DEFAULT 0, last_result_at INTEGER, last_reason TEXT);
    CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, status TEXT NOT NULL, status_code INTEGER,
      latency_ms REAL NOT NULL, reason TEXT);
    INSERT INTO checks (id, name, url, interval_ms) VALUES ('c', 'C', 'http://x/', 1000);
    INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason)
      VALUES ('c', 1, 'up', 200, 5, NULL);`);
  old.close();
  const s = createService(openDb(path));
  const got = s.listChecks()[0] as HttpCheck;
  assert.deepEqual([got.retries, got.retryDelayMs], [0, 1000]);
  assert.equal(s.listResults("c", 10)[0]!.attempts, 1);
  s.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
    { id: "c", name: "C", url: "http://x/", intervalMs: 1000, retries: 1, retryDelayMs: 5 },
  ]);
  assert.equal((s.listChecks()[0] as HttpCheck).retries, 1);
});
