import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { AuditAction, AuditEntry, AuditPage, AuditTargetKind } from "@lorenzh/pulse-contract";
import { withDurableCommit } from "./db.ts";

/** An audit entry before it is committed: `audit_log` assigns its id. */
export type AuditRecord = Omit<AuditEntry, "id">;

/** The D9 filters. `since` is inclusive, `until` exclusive; both apply to `at`. */
export interface AuditFilter {
  actor?: string;
  action?: AuditAction;
  targetKind?: AuditTargetKind;
  targetId?: string;
  since?: number;
  until?: number;
}

export interface AuditPageQuery extends AuditFilter {
  limit: number;
  /** Only entries with an id below this one. */
  before?: number;
}

export interface AuditLog {
  /** Insert one entry in a transaction; inside an outer transaction it commits with it. */
  record(entry: AuditRecord): AuditEntry;
  /** Matching entries by id descending, and the cursor of the next page or null. */
  query(q: AuditPageQuery): AuditPage;
  /** Matching entries by id ascending in batches, up to the largest id when the walk starts. */
  batches(filter: AuditFilter, size?: number): Iterable<AuditEntry[]>;
}

/** A config write between its temp file and its confirmation. Its id is never shown. */
export interface PendingEntry {
  pendingId: number;
  entry: AuditRecord & { revision: string };
  tempPath: string;
}

/** Storage of pending config-write entries (D8). */
export interface PendingAudit {
  /** Durably insert the pending row of a config write. */
  insert(entry: AuditRecord & { revision: string }, tempPath: string): void;
  /** Durably delete every pending row that names `tempPath`. */
  deleteByTemp(tempPath: string): void;
  /** Move one pending row into `audit_log` in one normal transaction. */
  promote(pendingId: number): AuditEntry;
  /** All pending rows by ascending pending id. */
  list(): PendingEntry[];
}

export class AuditPendingNotFoundError extends Error {
  override name = "AuditPendingNotFoundError";
}

/** Rows of the store's own tables; the columns are written only by this module. */
interface EntryColumns {
  at: number;
  actor_token_id: string | null;
  actor_name: string;
  action: AuditAction;
  target_kind: AuditTargetKind;
  target_id: string;
}
interface AuditRow extends EntryColumns {
  id: number;
  revision: string | null;
}
interface PendingRow extends EntryColumns {
  id: number;
  revision: string;
  temp_path: string;
}

const COLUMNS = "at, actor_token_id, actor_name, action, target_kind, target_id, revision";
const EXPORT_BATCH = 500;

function toRecord(row: EntryColumns & { revision: string | null }): AuditRecord {
  return {
    at: row.at,
    actor: { tokenId: row.actor_token_id, name: row.actor_name },
    action: row.action,
    target: { kind: row.target_kind, id: row.target_id },
    revision: row.revision,
  };
}

function toEntry(row: AuditRow): AuditEntry {
  return { id: row.id, ...toRecord(row) };
}

function values(e: AuditRecord): SQLQueryBindings[] {
  return [e.at, e.actor.tokenId, e.actor.name, e.action, e.target.kind, e.target.id, e.revision];
}

function where(f: AuditFilter): { sql: string[]; args: SQLQueryBindings[] } {
  const sql: string[] = [];
  const args: SQLQueryBindings[] = [];
  const add = (clause: string, value: SQLQueryBindings | undefined): void => {
    if (value === undefined) return;
    sql.push(clause);
    args.push(value);
  };
  add("actor_token_id = ?", f.actor);
  add("action = ?", f.action);
  add("target_kind = ?", f.targetKind);
  add("target_id = ?", f.targetId);
  add("at >= ?", f.since);
  add("at < ?", f.until);
  return { sql, args };
}

function insertEntry(db: Database, entry: AuditRecord): AuditEntry {
  const row = db
    .query(`INSERT INTO audit_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(...values(entry)) as { id: number } | null;
  if (row === null) throw new Error("audit insert returned no id");
  return { id: row.id, ...entry };
}

export function createAuditLog(db: Database): AuditLog {
  const select = (clauses: string[], args: SQLQueryBindings[], tail: string): AuditEntry[] => {
    const cond = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .query(`SELECT id, ${COLUMNS} FROM audit_log ${cond} ${tail}`)
      .all(...args) as AuditRow[];
    return rows.map(toEntry);
  };
  return {
    record: (entry) => db.transaction(() => insertEntry(db, entry))(),
    query(q) {
      const { sql, args } = where(q);
      if (q.before !== undefined) {
        sql.push("id < ?");
        args.push(q.before);
      }
      const rows = select(sql, [...args, q.limit + 1], "ORDER BY id DESC LIMIT ?");
      const entries = rows.slice(0, q.limit);
      const last = entries.at(-1);
      return { entries, nextBefore: rows.length > q.limit && last ? last.id : null };
    },
    *batches(filter, size = EXPORT_BATCH) {
      const top = db.query("SELECT MAX(id) AS id FROM audit_log").get() as { id: number | null };
      if (top.id === null) return;
      const { sql, args } = where(filter);
      let lastId = 0;
      for (;;) {
        const batch = select(
          [...sql, "id > ?", "id <= ?"],
          [...args, lastId, top.id, size],
          "ORDER BY id ASC LIMIT ?",
        );
        const last = batch.at(-1);
        if (last === undefined) return;
        yield batch;
        lastId = last.id;
      }
    },
  };
}

/**
 * The SQLite PendingAudit. `insert` and `deleteByTemp` run through `durable` (the real
 * `withDurableCommit` unless a test passes a spy), so they are on disk when they return.
 */
export function createPendingAudit(
  db: Database,
  durable: <T>(fn: () => T) => T = (fn) => withDurableCommit(db, fn),
): PendingAudit {
  return {
    insert(entry, tempPath) {
      durable(() =>
        db
          .query(
            `INSERT INTO audit_pending (${COLUMNS}, temp_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values(entry), tempPath),
      );
    },
    deleteByTemp(tempPath) {
      durable(() => db.query("DELETE FROM audit_pending WHERE temp_path = ?").run(tempPath));
    },
    promote(pendingId) {
      return db.transaction(() => {
        const row = db
          .query(`SELECT id, ${COLUMNS} FROM audit_pending WHERE id = ?`)
          .get(pendingId) as AuditRow | null;
        if (row === null) throw new AuditPendingNotFoundError("audit pending entry not found");
        const entry = insertEntry(db, toRecord(row));
        db.query("DELETE FROM audit_pending WHERE id = ?").run(pendingId);
        return entry;
      })();
    },
    list() {
      const rows = db
        .query(`SELECT id, ${COLUMNS}, temp_path FROM audit_pending ORDER BY id ASC`)
        .all() as PendingRow[];
      return rows.map((row) => ({
        pendingId: row.id,
        entry: { ...toRecord(row), revision: row.revision },
        tempPath: row.temp_path,
      }));
    },
  };
}
