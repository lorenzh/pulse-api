import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, withDurableCommit } from "./db.ts";

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

function pragmas(db: { query: (sql: string) => { get: () => unknown } }): {
  mode: unknown;
  sync: unknown;
} {
  const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode;
  const sync = (db.query("PRAGMA synchronous").get() as { synchronous: unknown }).synchronous;
  return { mode, sync };
}

test("a file database uses WAL with synchronous NORMAL, also a file made in delete mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const path = join(dir, "pulse.db");
    const db = openDb(path);
    assert.deepEqual(pragmas(db), { mode: "wal", sync: 1 });
    db.close();

    const old = join(dir, "old.db");
    const plain = new Database(old);
    plain.run("PRAGMA journal_mode = DELETE");
    plain.run("CREATE TABLE t (x INTEGER)");
    plain.close();
    const migrated = openDb(old);
    assert.deepEqual(pragmas(migrated), { mode: "wal", sync: 1 });
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an in-memory database keeps its journal mode and synchronous FULL", () => {
  const db = openDb(":memory:");
  assert.deepEqual(pragmas(db), { mode: "memory", sync: 2 });
  db.close();
});

function synchronous(db: Database): number {
  return (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
}

function journal(db: Database): string {
  return (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
}

/** Levels read inside `fn` and after it, for a returning and for a throwing `fn`. */
function durableLevels(db: Database): number[] {
  const seen: number[] = [];
  withDurableCommit(db, () => {
    seen.push(synchronous(db));
  });
  seen.push(synchronous(db));
  expect(() =>
    withDurableCommit(db, () => {
      seen.push(synchronous(db));
      throw new Error("boom");
    }),
  ).toThrow("boom");
  seen.push(synchronous(db));
  return seen;
}

test("withDurableCommit runs at EXTRA on a WAL file and restores NORMAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const db = openDb(join(dir, "pulse.db"));
    expect(journal(db)).toBe("wal");
    expect(durableLevels(db)).toEqual([3, 1, 3, 1]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withDurableCommit runs at EXTRA on a delete-mode file and restores FULL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-db-"));
  try {
    const db = new Database(join(dir, "plain.db"));
    db.run("PRAGMA journal_mode = DELETE");
    expect(journal(db)).toBe("delete");
    expect(durableLevels(db)).toEqual([3, 2, 3, 2]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withDurableCommit runs at EXTRA on :memory: and restores FULL", () => {
  const db = openDb(":memory:");
  expect(durableLevels(db)).toEqual([3, 2, 3, 2]);
  db.close();
});

test("withDurableCommit throws inside a transaction and leaves synchronous unchanged", () => {
  const db = openDb(":memory:");
  let ran = false;
  expect(() =>
    db.transaction(() =>
      withDurableCommit(db, () => {
        ran = true;
      }),
    )(),
  ).toThrow("withDurableCommit must run outside a transaction");
  expect(ran).toBe(false);
  expect(synchronous(db)).toBe(2);
  db.close();
});
