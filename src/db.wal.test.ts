import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

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

test("a reader on a second connection is not blocked by a writer in BEGIN EXCLUSIVE", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-wal-"));
  const path = join(dir, "pulse.db");
  const writer = openDb(path);
  const reader = openDb(path);
  try {
    const writes = createService(writer);
    writes.upsertChecks([check]);
    writes.ingest(result(1000, "up"));

    // BEGIN EXCLUSIVE, not BEGIN or BEGIN IMMEDIATE: those do not block a rollback-journal reader.
    writer.run("BEGIN EXCLUSIVE");
    const insert = writer.prepare(
      "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('c1', ?, 'down', 5)",
    );
    insert.run(2000);
    insert.run(3000);
    writer.run(
      "UPDATE checks SET state = 'down', last_result_at = 3000, consecutive_down = 2 WHERE id = 'c1'",
    );

    // busy_timeout 0: a blocked read fails at once instead of waiting.
    reader.run("PRAGMA busy_timeout = 0");
    const reads = createService(reader);
    // The clock only measures the reads; nothing waits on it (documented exception to the
    // no-real-clock rule).
    const started = performance.now();
    const checks = reads.listChecks();
    const states = reads.listCheckStates();
    const elapsed = performance.now() - started;

    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.state, "up");
    assert.equal(checks[0]?.lastResultAt, 1000);
    assert.deepEqual(states, [{ id: "c1", state: "up" }]);
    expect(elapsed).toBeLessThan(50);
    writer.run("COMMIT");
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
