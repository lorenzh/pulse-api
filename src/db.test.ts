import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

function namesOf(path: string, type: "table" | "index"): string[] {
  const db = openDb(path);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type);
  db.close();
  return rows.map((r) => String((r as { name: string }).name));
}

test("a fresh database file gets the full schema with all indexes, also when opened twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const path = join(dir, "t.db");
    for (const round of [1, 2]) {
      const tables = namesOf(path, "table");
      for (const t of [
        "checks",
        "results",
        "incidents",
        "manual_incidents",
        "manual_incident_updates",
      ]) {
        assert.ok(tables.includes(t), `${t} in round ${round}`);
      }
      const indexes = namesOf(path, "index");
      for (const i of [
        "results_by_check",
        "results_by_location",
        "results_by_time",
        "incidents_check_id",
      ]) {
        assert.ok(indexes.includes(i), `${i} in round ${round}`);
      }
    }
    const db = openDb(path);
    const columns = (table: string): string[] =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String((r as { name: string }).name));
    for (const c of ["active", "type", "keyword", "grace_ms", "latency_objective_ms"]) {
      assert.ok(columns("checks").includes(c), c);
    }
    for (const c of ["late", "location", "cert_days_left", "attempts"]) {
      assert.ok(columns("results").includes(c), c);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreign keys are enforced", () => {
  const db = openDb(":memory:");
  expect(() =>
    db.run(
      "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('nope', 1, 'up', 1)",
    ),
  ).toThrow();
  db.close();
});
