import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown',
  consecutive_down INTEGER NOT NULL DEFAULT 0,
  last_result_at INTEGER,
  last_reason TEXT
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL REFERENCES checks(id),
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms REAL NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS results_by_check ON results (check_id, timestamp DESC, id DESC);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL REFERENCES checks(id),
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  reason TEXT
);
`;

/** Open (or create) the database at `path` (":memory:" in tests) and ensure the schema. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
