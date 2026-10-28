import { DatabaseSync } from "node:sqlite";

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
  reason TEXT,
  location TEXT NOT NULL DEFAULT 'default',
  cert_days_left INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1
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
  migrate(db);
  return db;
}

/** Bring databases created by older versions up to the current schema. */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(results)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "location")) {
    db.exec("ALTER TABLE results ADD COLUMN location TEXT NOT NULL DEFAULT 'default'");
  }
  if (!columns.some((c) => c.name === "cert_days_left")) {
    db.exec("ALTER TABLE results ADD COLUMN cert_days_left INTEGER");
  }
  if (!columns.some((c) => c.name === "attempts")) {
    db.exec("ALTER TABLE results ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
  }
  const checkColumns = db.prepare("PRAGMA table_info(checks)").all() as { name: string }[];
  const addCheckColumn = (name: string, ddl: string): void => {
    if (!checkColumns.some((c) => c.name === name)) db.exec(`ALTER TABLE checks ADD COLUMN ${ddl}`);
  };
  addCheckColumn("type", "type TEXT NOT NULL DEFAULT 'http'");
  addCheckColumn("host", "host TEXT");
  addCheckColumn("port", "port INTEGER");
  addCheckColumn("warn_days", "warn_days INTEGER");
  addCheckColumn("latency_objective_ms", "latency_objective_ms INTEGER");
  addCheckColumn("retries", "retries INTEGER");
  addCheckColumn("retry_delay_ms", "retry_delay_ms INTEGER");
  db.exec(
    "CREATE INDEX IF NOT EXISTS results_by_location ON results (check_id, location, timestamp)",
  );
}
