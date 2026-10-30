import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'http',
  host TEXT,
  port INTEGER,
  warn_days INTEGER,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER,
  latency_objective_ms INTEGER,
  retries INTEGER,
  retry_delay_ms INTEGER,
  keyword TEXT,
  method TEXT,
  headers_json TEXT,
  body TEXT,
  expected_status_json TEXT,
  json_assert_json TEXT,
  period_ms INTEGER,
  grace_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown',
  consecutive_down INTEGER NOT NULL DEFAULT 0,
  last_result_at INTEGER,
  last_reason TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL REFERENCES checks(id),
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms REAL NOT NULL,
  reason TEXT,
  location TEXT NOT NULL DEFAULT 'default',
  cert_days_left INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  late INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS results_by_check ON results (check_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS results_by_location ON results (check_id, location, timestamp);
CREATE INDEX IF NOT EXISTS results_by_time ON results (timestamp);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL REFERENCES checks(id),
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS incidents_check_id ON incidents (check_id);
CREATE TABLE IF NOT EXISTS manual_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,
  component_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS manual_incident_updates (
  incident_id INTEGER NOT NULL REFERENCES manual_incidents(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (incident_id, n)
);
`;

/**
 * Open (or create) the database at `path` (":memory:" in tests) and create the current schema.
 * There is no upgrade path: a database file from an older version is not migrated.
 */
export function openDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);
  return db;
}
