import type { Database } from "bun:sqlite";
import {
  type AdminMaintenanceWindowInput,
  validateAdminMaintenanceWindowInput,
} from "@lorenzh/pulse-contract";

/** A stored database window: the validated input and its creation and change times. */
export interface WindowDefinition {
  id: string;
  /** Check ids in the order sent; some may not be effective right now. */
  checkIds: string[];
  start: number;
  end: number;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** A value the store refuses to keep; the message names a field path, never a value. */
export class MaintenanceStoreError extends Error {
  override name = "MaintenanceStoreError";
}

/**
 * The SQL of `maintenance_definitions`. Every write runs in a transaction; inside the caller's
 * transaction it commits or rolls back with it.
 */
export interface MaintenanceStore {
  /** All definitions in creation order. */
  list(): WindowDefinition[];
  get(id: string): WindowDefinition | null;
  count(): number;
  /** Throws MaintenanceStoreError when the id exists or the window is not valid. */
  create(window: AdminMaintenanceWindowInput): WindowDefinition;
  /** Replaces in place: the creation time and order stay. Returns null for an unknown id. */
  replace(window: AdminMaintenanceWindowInput): WindowDefinition | null;
  /** Returns false for an unknown id. */
  delete(id: string): boolean;
}

export interface MaintenanceStoreDeps {
  db: Database;
  now: () => number;
}

interface WindowRow {
  id: string;
  check_ids_json: string;
  start_ms: number;
  end_ms: number;
  note: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS = "id, check_ids_json, start_ms, end_ms, note, created_at, updated_at";

// check_ids_json is written only by this module, from a validated window.
const toDefinition = (row: WindowRow): WindowDefinition => ({
  id: row.id,
  checkIds: JSON.parse(row.check_ids_json) as string[],
  start: row.start_ms,
  end: row.end_ms,
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function assertWindow(window: unknown): AdminMaintenanceWindowInput {
  const v = validateAdminMaintenanceWindowInput(window, "window");
  if (!v.ok) throw new MaintenanceStoreError(`window is not valid: ${v.error}`);
  return v.value;
}

export function createMaintenanceStore({ db, now }: MaintenanceStoreDeps): MaintenanceStore {
  const get = (id: string): WindowDefinition | null => {
    const row = db
      .query<WindowRow, [string]>(`SELECT ${COLUMNS} FROM maintenance_definitions WHERE id = ?`)
      .get(id);
    return row === null ? null : toDefinition(row);
  };
  return {
    list: () =>
      db
        .query<WindowRow, []>(
          `SELECT ${COLUMNS} FROM maintenance_definitions ORDER BY created_at, rowid`,
        )
        .all()
        .map(toDefinition),
    get,
    count: () =>
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM maintenance_definitions").get()?.n ??
      0,
    create: (input) =>
      db.transaction(() => {
        const w = assertWindow(input);
        if (get(w.id) !== null) throw new MaintenanceStoreError("the window id already exists");
        const at = now();
        db.query(
          `INSERT INTO maintenance_definitions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(w.id, JSON.stringify(w.checkIds), w.start, w.end, w.note, at, at);
        return { ...w, checkIds: [...w.checkIds], createdAt: at, updatedAt: at };
      })(),
    replace: (input) =>
      db.transaction(() => {
        const w = assertWindow(input);
        const old = get(w.id);
        if (old === null) return null;
        const at = now();
        db.query(
          "UPDATE maintenance_definitions SET check_ids_json = ?, start_ms = ?, end_ms = ?, note = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(w.checkIds), w.start, w.end, w.note, at, w.id);
        return { ...w, checkIds: [...w.checkIds], createdAt: old.createdAt, updatedAt: at };
      })(),
    delete: (id) =>
      db.transaction(
        () => db.query("DELETE FROM maintenance_definitions WHERE id = ?").run(id).changes > 0,
      )(),
  };
}
