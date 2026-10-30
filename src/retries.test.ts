import { test } from "bun:test";
import assert from "node:assert/strict";
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

test("db: a check without retries reads retries as 0, and a result reads attempts as 1", () => {
  const db = openDb(":memory:");
  db.run(`INSERT INTO checks (id, name, url, interval_ms) VALUES ('c', 'C', 'http://x/', 1000);
    INSERT INTO results (check_id, timestamp, status, status_code, latency_ms)
      VALUES ('c', 1, 'up', 200, 5)`);
  const s = createService(db);
  const got = s.listChecks()[0] as HttpCheck;
  assert.deepEqual([got.retries, got.retryDelayMs], [0, 1000]);
  assert.equal(s.listResults("c", 10)[0]!.attempts, 1);
  s.upsertChecks([
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
    { id: "c", name: "C", url: "http://x/", intervalMs: 1000, retries: 1, retryDelayMs: 5 },
  ]);
  assert.equal((s.listChecks()[0] as HttpCheck).retries, 1);
});
