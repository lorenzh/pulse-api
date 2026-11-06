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
  // 5: token metadata looks up rotation credentials by token id for every listed token.
  `CREATE INDEX token_secrets_by_token_id ON token_secrets (token_id);`,
  // 6: checks created over the admin api, apart from the runtime table `checks`, and the state of
  // the applied checks file. Runtime rows are never copied into check_definitions.
  `
CREATE TABLE check_definitions (
  id TEXT PRIMARY KEY,
  check_json TEXT NOT NULL,
  secret_sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE config_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  database_generation INTEGER NOT NULL,
  file_revision TEXT,
  file_applied_at INTEGER,
  file_snapshot_json TEXT
);
INSERT INTO config_state (id, database_generation) VALUES (1, 0);
`,
  // 7: manual incident drafts, private notes and visibility. Existing incidents become published
  // and public at their creation time, so their public JSON does not change.
  `
ALTER TABLE manual_incidents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE manual_incidents ADD COLUMN published_at INTEGER;
UPDATE manual_incidents SET published_at = created_at;
CREATE TABLE manual_incident_drafts (
  incident_id INTEGER PRIMARY KEY REFERENCES manual_incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE TABLE manual_incident_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES manual_incidents(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX manual_incident_notes_by_incident ON manual_incident_notes (incident_id, at, id);
`,
  // 8: maintenance windows written through the admin API. Nothing is copied from the file.
  `
CREATE TABLE maintenance_definitions (
  id TEXT PRIMARY KEY,
  check_ids_json TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  // 9: status settings, notify channels, service reports and resend commands written through the
  // admin and service APIs. `resend_requests.command_id` has no foreign key: a request row must
  // outlive the command it points to, so a retry learns that the command was handled.
  `
CREATE TABLE status_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL
);
CREATE TABLE notify_channels (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE service_reports (
  service TEXT PRIMARY KEY CHECK (service IN ('status', 'notify')),
  report_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE resend_commands (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER
);
CREATE INDEX resend_commands_by_delivery ON resend_commands (channel_id, key);
CREATE TABLE resend_requests (
  request_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status_generation INTEGER NOT NULL,
  notify_generation INTEGER NOT NULL
);
INSERT INTO runtime_state (id, status_generation, notify_generation) VALUES (1, 0, 0);
`,
];

/** The step that adds the unique sample index; `openDb` counts the duplicates it removes. */
export const DEDUPLICATE_STEP = 2;

export const SCHEMA_VERSION: number = MIGRATIONS.length;
