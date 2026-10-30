import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("migration adds the manual incident tables to an old database and keeps its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL);
      INSERT INTO checks (id, name, url, interval_ms) VALUES ('a', 'A', 'http://a/', 1000);`);
    old.close();
    for (const round of [1, 2]) {
      const db = openDb(path);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => String(r.name));
      assert.ok(tables.includes("manual_incidents"), `round ${round}`);
      assert.ok(tables.includes("manual_incident_updates"), `round ${round}`);
      assert.equal(db.prepare("SELECT count(*) AS n FROM checks").get()?.n, 1);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
