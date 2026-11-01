import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SchemaVersionError } from "./db.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-mig-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The schema of main before migrations (user_version 0), copied as the fixture.
const V0 = `
CREATE TABLE checks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'http',
  host TEXT, port INTEGER, warn_days INTEGER, interval_ms INTEGER NOT NULL, timeout_ms INTEGER,
  latency_objective_ms INTEGER, retries INTEGER, retry_delay_ms INTEGER, keyword TEXT, method TEXT,
  headers_json TEXT, body TEXT, expected_status_json TEXT, json_assert_json TEXT, period_ms INTEGER,
  grace_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown', consecutive_down INTEGER NOT NULL DEFAULT 0,
  last_result_at INTEGER, last_reason TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL REFERENCES checks(id),
  timestamp INTEGER NOT NULL, status TEXT NOT NULL, status_code INTEGER, latency_ms REAL NOT NULL,
  reason TEXT, location TEXT NOT NULL DEFAULT 'default', cert_days_left INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1, late INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX results_by_check ON results (check_id, timestamp DESC, id DESC);
CREATE INDEX results_by_location ON results (check_id, location, timestamp);
CREATE INDEX results_by_time ON results (timestamp);
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL REFERENCES checks(id),
  opened_at INTEGER NOT NULL, resolved_at INTEGER, reason TEXT
);
CREATE INDEX incidents_check_id ON incidents (check_id);
INSERT INTO checks (id, name, url, type, interval_ms, retries, keyword) VALUES ('h', 'H', 'https://x.example/', 'http', 1000, 2, 'k');
INSERT INTO checks (id, name, url, type, host, port, warn_days, interval_ms) VALUES ('t', 'T', '', 'tls', 'x.example', 443, 14, 1000);
INSERT INTO checks (id, name, url, type, interval_ms, period_ms, grace_ms) VALUES ('b', 'B', '', 'heartbeat', 5000, 5000, 0);
INSERT INTO results (check_id, timestamp, status, latency_ms, cert_days_left) VALUES ('h', 1, 'up', 3.5, NULL), ('t', 2, 'up', 4, 40);
INSERT INTO incidents (check_id, opened_at, reason) VALUES ('h', 5, 'boom');
`;

function makeV0(path: string): void {
  const db = new Database(path);
  db.run(V0);
  db.close();
}

function dump(db: Database): unknown[] {
  return ["checks", "results", "incidents"].map((t) =>
    db
      .query(
        t === "checks"
          ? "SELECT id, name, url, type, host, port, warn_days, interval_ms, retries, keyword, period_ms, grace_ms, state, active FROM checks ORDER BY id"
          : `SELECT * FROM ${t} ORDER BY id`,
      )
      .all(),
  );
}

function master(db: Database): unknown[] {
  // The fixture is formatted differently from the schema in db.ts, so only `checks` is compared as text.
  return db
    .query(
      "SELECT type, name, CASE WHEN name = 'checks' THEN sql END AS sql FROM sqlite_master ORDER BY type, name",
    )
    .all();
}

function version(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

test("a version 0 file upgrades in place and keeps rows, indexes and foreign keys", () => {
  const path = join(dir, "old.db");
  makeV0(path);
  const raw = new Database(path);
  const before = dump(raw);
  raw.close();
  const db = openDb(path);
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(dump(db)).toEqual(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'results_by%'")
      .all(),
  ).toHaveLength(4);
  db.run(
    "INSERT INTO checks (id, name, type, host, port, interval_ms) VALUES ('p', 'P', 'tcp', 'h', 1, 1000)",
  );
  db.run("INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('p', 1, 'up', 1)");
  expect(() =>
    db.run(
      "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('nope', 1, 'up', 1)",
    ),
  ).toThrow();
  db.close();
});

test("migration 3: a version 2 file becomes version 3 with an empty uptime_daily, rows kept", () => {
  const path = join(dir, "v2.db");
  makeV0(path);
  openDb(path, MIGRATIONS.slice(0, 2)).close();
  const v2 = new Database(path);
  expect(version(v2)).toBe(2);
  const tables = (db: Database): unknown =>
    db.query("SELECT name FROM sqlite_master WHERE name = 'uptime_daily'").all();
  expect(tables(v2)).toEqual([]);
  v2.close();
  const db = openDb(path, MIGRATIONS.slice(0, 3));
  expect(version(db)).toBe(3);
  expect(tables(db)).toEqual([{ name: "uptime_daily" }]);
  expect(db.query("SELECT COUNT(*) AS n FROM uptime_daily").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM results").get()).toEqual({ n: 2 });
  const pk = db.query("PRAGMA table_info(uptime_daily)").all() as { name: string; pk: number }[];
  expect(pk.map((c) => [c.name, c.pk])).toEqual([
    ["check_id", 1],
    ["day", 2],
    ["good", 0],
    ["total", 0],
  ]);
  db.close();
});

test("migration 4: a version 3 file becomes version 4 with the token and audit tables", () => {
  const path = join(dir, "v3.db");
  makeV0(path);
  openDb(path, MIGRATIONS.slice(0, 3)).close();
  const names = (db: Database): string[] =>
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_tokens', 'token_secrets', 'token_bootstrap', 'audit_log', 'audit_pending') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
  const v3 = new Database(path);
  expect(version(v3)).toBe(3);
  expect(names(v3)).toEqual([]);
  v3.close();
  const db = openDb(path, MIGRATIONS.slice(0, 4));
  expect(version(db)).toBe(4);
  expect(names(db)).toEqual([
    "api_tokens",
    "audit_log",
    "audit_pending",
    "token_bootstrap",
    "token_secrets",
  ]);
  expect(db.query("SELECT COUNT(*) AS n FROM results").get()).toEqual({ n: 2 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'audit_log_by_at'").get()).toEqual({
    name: "audit_log_by_at",
  });
  expect(() =>
    db.run("INSERT INTO token_bootstrap (kind, imported_at, count) VALUES ('other', 1, 1)"),
  ).toThrow();
  db.close();
});

test("migration 4: a version 5 file is refused", () => {
  const path = join(dir, "v5.db");
  const raw = new Database(path);
  raw.run("PRAGMA user_version = 5");
  raw.close();
  expect(() => openDb(path, MIGRATIONS.slice(0, 4))).toThrow(
    "database schema version 5 is newer than this program supports (4); downgrades are not supported",
  );
});

test("migration 5: token listing uses the token id index after upgrading version 4", () => {
  const path = join(dir, "v4.db");
  openDb(path, MIGRATIONS.slice(0, 4)).close();
  const db = openDb(path);
  try {
    const plan = db
      .query<{ detail: string }, [string, number]>(
        "EXPLAIN QUERY PLAN SELECT MAX(retires_at) AS until FROM token_secrets WHERE token_id = ? AND retires_at > ?",
      )
      .all("tok_example", 0);
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "USING INDEX token_secrets_by_token_id (token_id=?)",
    );
    expect(version(db)).toBe(5);
  } finally {
    db.close();
  }
});

test("a fresh file has the same schema as an upgraded one, and reopening changes nothing", () => {
  const fresh = openDb(join(dir, "fresh.db"));
  expect(version(fresh)).toBe(SCHEMA_VERSION);
  const old = join(dir, "old.db");
  makeV0(old);
  const upgraded = openDb(old);
  const strip = (rows: unknown[]): unknown[] =>
    rows.filter(
      (r) =>
        !["manual_incidents", "manual_incident_updates"].includes((r as { name: string }).name),
    );
  expect(strip(master(upgraded))).toEqual(strip(master(fresh)));
  const first = master(fresh);
  fresh.close();
  const again = openDb(join(dir, "fresh.db"));
  expect(master(again)).toEqual(first);
  expect(version(again)).toBe(SCHEMA_VERSION);
  again.close();
  upgraded.close();
});

test("a failing step rolls back and leaves the file at version 0", () => {
  const path = join(dir, "old.db");
  makeV0(path);
  const steps = ["ALTER TABLE checks ADD COLUMN extra TEXT;", "THIS IS NOT SQL"];
  expect(() => openDb(path, steps)).toThrow();
  const raw = new Database(path);
  expect(version(raw)).toBe(0);
  const columns = raw.query("PRAGMA table_info(checks)").all() as { name: string }[];
  expect(columns.some((c) => c.name === "extra")).toBe(false);
  raw.close();
});

test("a file from a newer program is refused", () => {
  const path = join(dir, "new.db");
  const raw = new Database(path);
  raw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  expect(() => openDb(path)).toThrow(SchemaVersionError);
  expect(() => openDb(path)).toThrow(
    `database schema version ${SCHEMA_VERSION + 1} is newer than this program supports (${SCHEMA_VERSION}); downgrades are not supported`,
  );
});

/** The SQL texts `openDb` runs through `query` while it opens `path`. */
function queriesOnOpen(path: string, steps?: readonly string[]): string[] {
  const spy = spyOn(Database.prototype, "query");
  try {
    (steps === undefined ? openDb(path) : openDb(path, steps)).close();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

test("the foreign key check runs only after a migration step, not on a fresh or current file", () => {
  const path = join(dir, "spy.db");
  expect(queriesOnOpen(path)).not.toContain("PRAGMA foreign_key_check");
  expect(queriesOnOpen(path)).not.toContain("PRAGMA foreign_key_check");
  const old = join(dir, "old.db");
  makeV0(old);
  expect(queriesOnOpen(old)).toContain("PRAGMA foreign_key_check");
});

test("a migration that leaves a row with a broken foreign key is refused and rolled back", () => {
  const path = join(dir, "orphan.db");
  makeV0(path);
  const raw = new Database(path);
  raw.run(
    "INSERT INTO results (check_id, timestamp, status, latency_ms) VALUES ('gone', 9, 'up', 1)",
  );
  raw.close();
  expect(() => openDb(path)).toThrow("schema migration left rows that break a foreign key");
  const after = new Database(path);
  expect(version(after)).toBe(0);
  after.close();
});

test("migration 2 removes duplicate results, keeps the first by rowid and logs the count", () => {
  const path = join(dir, "dup.db");
  makeV0(path);
  const raw = new Database(path);
  raw.run(
    `INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES
       ('h', 1, 'down', 9, 'default'), ('h', 1, 'up', 1, 'default'), ('h', 1, 'up', 1, 'default'),
       ('h', 1, 'up', 1, 'other'), ('h', 2, 'up', 1, 'default')`,
  );
  raw.close();
  const lines: string[] = [];
  const db = openDb(path, undefined, (line) => lines.push(line));
  const rows = db
    .query("SELECT latency_ms, location, timestamp FROM results WHERE check_id = 'h' ORDER BY id")
    .all();
  expect(rows).toEqual([
    { latency_ms: 3.5, location: "default", timestamp: 1 }, // the fixture row came first
    { latency_ms: 1, location: "other", timestamp: 1 },
    { latency_ms: 1, location: "default", timestamp: 2 },
  ]);
  expect(lines).toEqual(["migration 2: removed 3 duplicate results, kept the first of each"]);
  expect(() =>
    db.run(
      "INSERT INTO results (check_id, timestamp, status, latency_ms, location) VALUES ('h', 2, 'up', 1, 'default')",
    ),
  ).toThrow();
  db.close();
  const quiet: string[] = [];
  openDb(path, undefined, (line) => quiet.push(line)).close();
  expect(quiet).toEqual([]);
});
