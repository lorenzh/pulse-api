import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Check } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { res } from "./service.test.ts";
import { createService, UnknownCheckError } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const a: Check = { id: "c1", name: "A", url: "http://a/", intervalMs: 1000 };
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const b: Check = { id: "c2", name: "B", url: "http://b/", intervalMs: 1000 };

function downB(s: ReturnType<typeof createService>): void {
  for (let t = 1; t <= 3; t++) s.ingest({ ...res(t, "down"), checkId: "c2" });
}

test("removed check: hidden, resolved, reset, history kept; re-add restores", () => {
  const db = openDb(":memory:");
  const lines: string[] = [];
  const s = createService(db, { now: () => 5000, log: (l) => lines.push(l) });
  s.upsertChecks([a, b]);
  downB(s);
  assert.equal(s.listIncidents("open").length, 1);
  s.upsertChecks([a]);
  assert.deepEqual(
    s.listChecks().map((c) => c.id),
    ["c1"],
  );
  assert.deepEqual(
    s.getUptime().map((u) => u.checkId),
    ["c1"],
  );
  assert.throws(() => s.ingest({ ...res(10, "down"), checkId: "c2" }), UnknownCheckError);
  assert.equal(s.listIncidents("open").length, 0);
  assert.equal(s.listIncidents("resolved")[0]?.resolvedAt, 5000);
  assert.equal(lines.length, 1);
  assert.equal(s.hasCheck("c2"), true);
  assert.equal(s.listResults("c2", 10).length, 3);
  s.upsertChecks([a, b]);
  const back = s.listChecks().find((c) => c.id === "c2");
  assert.equal(back?.state, "unknown");
  assert.equal(back?.consecutiveDown, 0);
  assert.equal(s.listResults("c2", 10).length, 3);
  s.ingest({ ...res(20, "up"), checkId: "c2" });
});

test("migration adds active, defaulting to active, to a database without the column", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-mig-"));
  try {
    const path = join(dir, "old.db");
    const old = openDb(path);
    old.exec(
      "INSERT INTO checks (id, name, url, interval_ms) VALUES ('old', 'Old', 'http://o/', 1000)",
    );
    old.exec("ALTER TABLE checks DROP COLUMN active");
    old.close();
    const s = createService(openDb(path));
    assert.deepEqual(
      s.listChecks().map((c) => c.id),
      ["old"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention still prunes the results of an inactive check", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([a, b]);
  s.ingest({ ...res(1, "up"), checkId: "c2" });
  s.ingest({ ...res(2, "up"), checkId: "c2" });
  s.upsertChecks([a]);
  assert.deepEqual(
    s.listChecks().map((c) => c.id),
    ["c1"],
  );
  assert.equal(s.deleteExpiredResults(100, 10), 1);
  assert.equal(s.listResults("c2", 10).length, 1);
});
