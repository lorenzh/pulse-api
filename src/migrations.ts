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
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;
