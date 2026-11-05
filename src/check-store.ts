import type { Database } from "bun:sqlite";
import {
  type Check,
  type Component,
  validateCheck,
  validateComponent,
  validateMaintenanceWindow,
} from "@lorenzh/pulse-contract";
import { type FileMaintenanceWindow, isWindowId } from "./config.ts";

/** A stored database check: the check as it runs, and the digest of a heartbeat secret. */
export interface CheckDefinition {
  check: Check;
  /** Hex SHA-256 of the heartbeat secret; null for every other type. */
  secretSha256: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The last applied checks file, as the start falls back to it. Never a plaintext secret. */
export interface FileSnapshot {
  revision: string;
  appliedAt: number;
  checks: Check[];
  /** Hex SHA-256 of the ping secret per heartbeat check id. */
  secretDigests: Record<string, string>;
  components: Component[];
  /** File windows with their optional id; a snapshot written before ids existed has none. */
  maintenance: FileMaintenanceWindow[];
}

/** A value the store refuses to keep; the message never quotes a value. */
export class CheckStoreError extends Error {
  override name = "CheckStoreError";
}

/**
 * The SQL of check definitions, the database generation and the file snapshot. Every write runs in
 * a transaction; inside the caller's transaction it commits or rolls back with it.
 */
export interface CheckStore {
  /** All definitions in creation order. */
  list(): CheckDefinition[];
  get(id: string): CheckDefinition | null;
  /** Throws CheckStoreError when the id exists or the definition is not materialized. */
  create(check: Check, secretSha256: string | null): CheckDefinition;
  /** Replaces in place: the creation time and order stay. Returns null for an unknown id. */
  replace(check: Check, secretSha256: string | null): CheckDefinition | null;
  /** Returns false for an unknown id. */
  delete(id: string): boolean;
  generation(): number;
  /** Raises the generation by one and returns the new value. */
  bumpGeneration(): number;
  snapshot(): FileSnapshot | null;
  writeSnapshot(snapshot: FileSnapshot): void;
}

export interface CheckStoreDeps {
  db: Database;
  now: () => number;
}

interface DefinitionRow {
  check_json: string;
  secret_sha256: string | null;
  created_at: number;
  updated_at: number;
}

const DIGEST = /^[0-9a-f]{64}$/;

function assertCheck(check: unknown, where: string): void {
  const v = validateCheck(check, where);
  if (!v.ok) throw new CheckStoreError(`${where} is not a materialized check: ${v.error}`);
}

function assertDefinition(check: Check, secretSha256: string | null): void {
  assertCheck(check, "definition");
  if (check.type === "heartbeat") {
    if (secretSha256 === null || !DIGEST.test(secretSha256)) {
      throw new CheckStoreError("a heartbeat definition needs a hex SHA-256 secret digest");
    }
  } else if (secretSha256 !== null) {
    throw new CheckStoreError("only a heartbeat definition has a secret digest");
  }
}

function assertSnapshot(s: FileSnapshot): void {
  s.checks.forEach((c, i) => {
    assertCheck(c, `snapshot.checks[${i}]`);
  });
  const heartbeats = new Set(s.checks.filter((c) => c.type === "heartbeat").map((c) => c.id));
  const ids = Object.keys(s.secretDigests);
  for (const id of ids) {
    const digest = s.secretDigests[id];
    if (!heartbeats.has(id) || digest === undefined || !DIGEST.test(digest)) {
      throw new CheckStoreError("snapshot secret digests must be hex SHA-256 of heartbeat checks");
    }
  }
  if (ids.length !== heartbeats.size) {
    throw new CheckStoreError("snapshot needs a secret digest for every heartbeat check");
  }
  s.components.forEach((c, i) => {
    const v = validateComponent(c, `snapshot.components[${i}]`);
    if (!v.ok) throw new CheckStoreError(v.error);
  });
  s.maintenance.forEach((w, i) => {
    const { id, ...window } = w;
    const v = validateMaintenanceWindow(window, `snapshot.maintenance[${i}]`);
    if (!v.ok) throw new CheckStoreError(v.error);
    if (id !== undefined && (typeof id !== "string" || !isWindowId(id))) {
      throw new CheckStoreError(`snapshot.maintenance[${i}].id is not a window id`);
    }
  });
}

// check_json is written only by this module, from a validated check.
const toDefinition = (row: DefinitionRow): CheckDefinition => ({
  check: JSON.parse(row.check_json) as Check,
  secretSha256: row.secret_sha256,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const COLUMNS = "check_json, secret_sha256, created_at, updated_at";

export function createCheckStore({ db, now }: CheckStoreDeps): CheckStore {
  const get = (id: string): CheckDefinition | null => {
    const row = db
      .query<DefinitionRow, [string]>(`SELECT ${COLUMNS} FROM check_definitions WHERE id = ?`)
      .get(id);
    return row === null ? null : toDefinition(row);
  };
  const generation = (): number => {
    const row = db
      .query<{ g: number }, []>("SELECT database_generation AS g FROM config_state WHERE id = 1")
      .get();
    if (row === null) throw new CheckStoreError("config_state has no row");
    return row.g;
  };
  return {
    list: () =>
      db
        .query<DefinitionRow, []>(
          `SELECT ${COLUMNS} FROM check_definitions ORDER BY created_at, rowid`,
        )
        .all()
        .map(toDefinition),
    get,
    create: (check, secretSha256) =>
      db.transaction(() => {
        assertDefinition(check, secretSha256);
        if (get(check.id) !== null) throw new CheckStoreError("the check id already exists");
        const at = now();
        db.query(`INSERT INTO check_definitions (id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?)`).run(
          check.id,
          JSON.stringify(check),
          secretSha256,
          at,
          at,
        );
        return { check, secretSha256, createdAt: at, updatedAt: at };
      })(),
    replace: (check, secretSha256) =>
      db.transaction(() => {
        assertDefinition(check, secretSha256);
        const old = get(check.id);
        if (old === null) return null;
        const at = now();
        db.query(
          "UPDATE check_definitions SET check_json = ?, secret_sha256 = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(check), secretSha256, at, check.id);
        return { check, secretSha256, createdAt: old.createdAt, updatedAt: at };
      })(),
    delete: (id) =>
      db.transaction(
        () => db.query("DELETE FROM check_definitions WHERE id = ?").run(id).changes > 0,
      )(),
    generation,
    bumpGeneration: () =>
      db.transaction(() => {
        db.run(
          "UPDATE config_state SET database_generation = database_generation + 1 WHERE id = 1",
        );
        return generation();
      })(),
    snapshot: () => {
      const row = db
        .query<{ json: string | null }, []>(
          "SELECT file_snapshot_json AS json FROM config_state WHERE id = 1",
        )
        .get();
      // file_snapshot_json is written only by this module, from a validated snapshot.
      return row === null || row.json === null ? null : (JSON.parse(row.json) as FileSnapshot);
    },
    writeSnapshot: (snapshot) =>
      db.transaction(() => {
        assertSnapshot(snapshot);
        const json = JSON.stringify({
          revision: snapshot.revision,
          appliedAt: snapshot.appliedAt,
          checks: snapshot.checks,
          secretDigests: snapshot.secretDigests,
          components: snapshot.components,
          maintenance: snapshot.maintenance,
        });
        db.query(
          "UPDATE config_state SET file_revision = ?, file_applied_at = ?, file_snapshot_json = ? WHERE id = 1",
        ).run(snapshot.revision, snapshot.appliedAt, json);
      })(),
  };
}
