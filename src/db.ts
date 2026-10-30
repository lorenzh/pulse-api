import { Database } from "bun:sqlite";
import { DEDUPLICATE_STEP, MIGRATIONS } from "./migrations.ts";

/** The schema at `user_version` 0, as the first release created it. Later changes are migrations. */
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
-- Daily p50/p95 of closed UTC days. IF NOT EXISTS: a file from an older release gets it on open.
CREATE TABLE IF NOT EXISTS latency_daily (
  check_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  p50_ms REAL,
  p95_ms REAL,
  count INTEGER NOT NULL,
  PRIMARY KEY (check_id, day)
);
`;

export class SchemaVersionError extends Error {
  override name = "SchemaVersionError";
}

function readVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

/** Rows the deduplicating step will delete: all rows minus one per (check, location, timestamp). */
function countDuplicates(db: Database): number {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) FROM results)
            - (SELECT COUNT(*) FROM (SELECT 1 FROM results GROUP BY check_id, location, timestamp)) AS n`,
    )
    .get() as { n: number } | null;
  return row?.n ?? 0;
}

function migrate(db: Database, steps: readonly string[], log: (line: string) => void): void {
  const current = readVersion(db);
  if (current > steps.length) {
    throw new SchemaVersionError(
      `database schema version ${current} is newer than this program supports (${steps.length}); downgrades are not supported`,
    );
  }
  // A fresh file has no rows to check; a current file runs no step. Both skip the slow full-table check.
  const fresh = db.query("SELECT 1 FROM sqlite_master LIMIT 1").get() === null;
  const checkForeignKeys = !fresh && current < steps.length;
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
  db.run("PRAGMA foreign_keys = OFF");
  let removed = 0;
  try {
    db.run("BEGIN IMMEDIATE");
    try {
      db.run(SCHEMA);
      removed =
        !fresh && current < DEDUPLICATE_STEP && steps.length >= DEDUPLICATE_STEP
          ? countDuplicates(db)
          : 0;
      for (let n = current + 1; n <= steps.length; n++) {
        db.run(steps[n - 1] ?? "");
        db.run(`PRAGMA user_version = ${n}`);
      }
      const broken = checkForeignKeys ? db.query("PRAGMA foreign_key_check").all() : [];
      if (broken.length > 0) {
        throw new SchemaVersionError("schema migration left rows that break a foreign key");
      }
      db.run("COMMIT");
      if (removed > 0) {
        log(
          `migration ${DEDUPLICATE_STEP}: removed ${removed} duplicate results, kept the first of each`,
        );
      }
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

/**
 * Open (or create) the database at `path` (":memory:" in tests) and bring it to the current
 * schema in one transaction. A file from a newer program is refused with a SchemaVersionError.
 * `log` receives one line when a migration deleted duplicate rows.
 */
export function openDb(
  path: string,
  steps: readonly string[] = MIGRATIONS,
  log: (line: string) => void = () => undefined,
): Database {
  const db = new Database(path);
  try {
    migrate(db, steps, log);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
