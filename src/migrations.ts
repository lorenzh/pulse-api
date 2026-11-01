/**
 * Numbered schema steps. Step n (index n - 1) takes a database from `user_version` n - 1 to n.
 * Version 0 is the schema in `db.ts`. Never edit a released step: add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: tcp, dns and domain checks. SQLite cannot drop NOT NULL, so `checks` is rebuilt with a
  // nullable `url` and the new target columns. `host`, `port` and `warn_days` are reused.
  `
CREATE TABLE checks_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
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
  active INTEGER NOT NULL DEFAULT 1,
  dns_name TEXT,
  record_type TEXT,
  expected_json TEXT,
  resolver TEXT,
  domain TEXT
);
INSERT INTO checks_new (id, name, url, type, host, port, warn_days, interval_ms, timeout_ms,
  latency_objective_ms, retries, retry_delay_ms, keyword, method, headers_json, body,
  expected_status_json, json_assert_json, period_ms, grace_ms, state, consecutive_down,
  last_result_at, last_reason, active)
SELECT id, name, url, type, host, port, warn_days, interval_ms, timeout_ms,
  latency_objective_ms, retries, retry_delay_ms, keyword, method, headers_json, body,
  expected_status_json, json_assert_json, period_ms, grace_ms, state, consecutive_down,
  last_result_at, last_reason, active
FROM checks;
DROP TABLE checks;
ALTER TABLE checks_new RENAME TO checks;
`,
  // 2: idempotent ingest. A sample is one (check, location, timestamp). Duplicates keep the first
  // row by rowid.
  `
DELETE FROM results WHERE id NOT IN (SELECT MIN(id) FROM results GROUP BY check_id, location, timestamp);
CREATE UNIQUE INDEX results_by_sample ON results (check_id, location, timestamp);
`,
  // 3: the stored uptime tally of each closed UTC day. A step, not CREATE TABLE IF NOT EXISTS: an
  // older release would store late results without updating these rows, so it must refuse the file.
  // The rows are filled after the start, by the uptime backfill and by reads.
  `
CREATE TABLE uptime_daily (
  check_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  good INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (check_id, day)
);
`,
  // 4: hashed, scoped tokens and the audit log. Only digests of secrets are stored. An audit_log id
  // is assigned in the transaction that commits the entry, so id order is commit order.
  // audit_pending holds the intent of a config write between its temp file and its confirmation.
  `
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  location TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  rotated_at INTEGER
);
CREATE TABLE token_secrets (
  secret_sha256 TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES api_tokens(id),
  created_at INTEGER NOT NULL,
  retires_at INTEGER
);
CREATE TABLE token_bootstrap (
  kind TEXT PRIMARY KEY CHECK (kind IN ('probe','admin')),
  imported_at INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_token_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision TEXT
);
CREATE INDEX audit_log_by_at ON audit_log (at, id);
CREATE TABLE audit_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_token_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  temp_path TEXT NOT NULL
);
`,
];

/** The step that adds the unique sample index; `openDb` counts the duplicates it removes. */
export const DEDUPLICATE_STEP = 2;

export const SCHEMA_VERSION: number = MIGRATIONS.length;
