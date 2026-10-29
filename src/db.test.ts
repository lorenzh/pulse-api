import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";

test("migration creates the incident and per-location result indexes, also when run twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const path = join(dir, "t.db");
    const names = (): string[] => {
      const db = openDb(path);
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
      db.close();
      return rows.map((r) => String(r.name));
    };
    for (const round of [1, 2]) {
      const found = names();
      assert.ok(found.includes("incidents_check_id"), `round ${round}`);
      assert.ok(found.includes("results_by_location"), `round ${round}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
