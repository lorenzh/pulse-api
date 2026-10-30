import type { DatabaseSync } from "node:sqlite";
import {
  MANUAL_INCIDENT_MAX_UPDATES,
  type ManualIncident,
  type ManualIncidentImpact,
  type ManualIncidentStatus,
  type ManualIncidentUpdate,
  validateManualIncidentInput,
  validateManualIncidentUpdateInput,
} from "@lorenzh/pulse-contract";

export const RECENT_RESOLVED_MS = 14 * 86_400_000;
export const RECENT_RESOLVED_LIMIT = 50;
const DEFAULT_RESOLVE_MESSAGE = "Resolved.";

export type ManualIncidentFilter = "open" | "resolved" | "all";

export class ManualIncidentInputError extends Error {
  override name = "ManualIncidentInputError";
}

export class ManualIncidentNotFoundError extends Error {
  override name = "ManualIncidentNotFoundError";
}

/** The incident is resolved, or has reached the update limit. */
export class ManualIncidentConflictError extends Error {
  override name = "ManualIncidentConflictError";
}

export interface ManualIncidentStore {
  /** Open ones first (newest created first), then up to 50 resolved within 14 days, newest first. */
  list(filter: ManualIncidentFilter): ManualIncident[];
  get(id: number): ManualIncident | undefined;
  create(body: unknown): ManualIncident;
  addUpdate(id: number, body: unknown): ManualIncident;
  /** `body` may be undefined or an object with an optional `message`. */
  resolve(id: number, body: unknown): ManualIncident;
  remove(id: number): void;
  /** Delete incidents resolved before `cutoff` (epoch ms). Returns how many. */
  deleteResolvedBefore(cutoff: number): number;
}

export interface ManualIncidentDeps {
  now: () => number;
  /** Ids of the configured components. */
  componentIds: ReadonlySet<string>;
  /** Called once per created incident and once per resolution. */
  onEvent?: (event: "created" | "resolved") => void;
}

type IncidentRow = {
  id: number;
  title: string;
  impact: ManualIncidentImpact;
  component_ids_json: string;
  status: ManualIncidentStatus;
  created_at: number;
  resolved_at: number | null;
};

type UpdateRow = { n: number; at: number; status: ManualIncidentStatus; message: string };

function parseIds(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

/** The message of a resolve request: the default for no body or no message. */
function resolveMessage(body: unknown): string {
  if (body === undefined) return DEFAULT_RESOLVE_MESSAGE;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ManualIncidentInputError("body must be a JSON object");
  }
  const { message } = body as { message?: unknown };
  if (message === undefined) return DEFAULT_RESOLVE_MESSAGE;
  const parsed = validateManualIncidentUpdateInput({ status: "resolved", message });
  if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
  return parsed.value.message;
}

/** Store of manual incidents. Times come from `now`; update numbers are the row index. */
export function createManualIncidentStore(
  db: DatabaseSync,
  { now, componentIds, onEvent }: ManualIncidentDeps,
): ManualIncidentStore {
  const insertIncident = db.prepare(
    `INSERT INTO manual_incidents (title, impact, component_ids_json, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  const insertUpdate = db.prepare(
    "INSERT INTO manual_incident_updates (incident_id, n, at, status, message) VALUES (?, ?, ?, ?, ?)",
  );
  const setStatus = db.prepare(
    "UPDATE manual_incidents SET status = ?, resolved_at = ? WHERE id = ?",
  );
  const selectOne = db.prepare("SELECT * FROM manual_incidents WHERE id = ?");
  const selectUpdates = db.prepare(
    "SELECT n, at, status, message FROM manual_incident_updates WHERE incident_id = ? ORDER BY n",
  );
  const selectOpen = db.prepare(
    "SELECT * FROM manual_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC",
  );
  const selectResolved = db.prepare(
    `SELECT * FROM manual_incidents WHERE resolved_at IS NOT NULL AND resolved_at >= ?
     ORDER BY resolved_at DESC, id DESC LIMIT ?`,
  );
  const deleteOne = db.prepare("DELETE FROM manual_incidents WHERE id = ?");
  const deleteOld = db.prepare(
    "DELETE FROM manual_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?",
  );

  const toIncident = (row: IncidentRow): ManualIncident => {
    const updates = (selectUpdates.all(row.id) as unknown as UpdateRow[]).map(
      (u): ManualIncidentUpdate => ({ at: u.at, status: u.status, message: u.message }),
    );
    return {
      id: row.id,
      title: row.title,
      componentIds: parseIds(row.component_ids_json),
      impact: row.impact,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      updates,
    };
  };

  const rowOf = (id: number): IncidentRow => {
    const row = selectOne.get(id) as IncidentRow | undefined;
    if (row === undefined) throw new ManualIncidentNotFoundError(`unknown manual incident ${id}`);
    return row;
  };

  const inTransaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  /** Append an update inside a transaction; sets the status and `resolvedAt`. */
  const append = (id: number, status: ManualIncidentStatus, message: string): ManualIncident =>
    inTransaction(() => {
      const row = rowOf(id);
      if (row.status === "resolved") {
        throw new ManualIncidentConflictError("manual incident is resolved");
      }
      const updates = selectUpdates.all(id) as unknown as UpdateRow[];
      if (updates.length >= MANUAL_INCIDENT_MAX_UPDATES) {
        throw new ManualIncidentConflictError(
          `manual incident has the most updates it takes (${MANUAL_INCIDENT_MAX_UPDATES})`,
        );
      }
      // Never earlier than the last update, so the order by `at` holds if the clock steps back.
      const at = Math.max(now(), updates.at(-1)?.at ?? 0);
      insertUpdate.run(id, updates.length, at, status, message);
      setStatus.run(status, status === "resolved" ? at : null, id);
      return toIncident(rowOf(id));
    });

  const notifyResolved = (incident: ManualIncident): ManualIncident => {
    if (incident.status === "resolved") onEvent?.("resolved");
    return incident;
  };

  return {
    list(filter) {
      const open = filter === "resolved" ? [] : (selectOpen.all() as unknown as IncidentRow[]);
      const resolved =
        filter === "open"
          ? []
          : (selectResolved.all(
              now() - RECENT_RESOLVED_MS,
              RECENT_RESOLVED_LIMIT,
            ) as unknown as IncidentRow[]);
      return [...open, ...resolved].map(toIncident);
    },

    get(id) {
      const row = selectOne.get(id) as IncidentRow | undefined;
      return row === undefined ? undefined : toIncident(row);
    },

    create(body) {
      const parsed = validateManualIncidentInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      const input = parsed.value;
      for (const id of input.componentIds) {
        if (!componentIds.has(id)) {
          throw new ManualIncidentInputError(`componentIds: unknown component "${id}"`);
        }
      }
      const at = now();
      const status = input.status ?? "investigating";
      const incident = inTransaction(() => {
        const id = Number(
          insertIncident.run(
            input.title,
            input.impact,
            JSON.stringify(input.componentIds),
            status,
            at,
          ).lastInsertRowid,
        );
        insertUpdate.run(id, 0, at, status, input.message);
        return toIncident(rowOf(id));
      });
      onEvent?.("created");
      return incident;
    },

    addUpdate(id, body) {
      const parsed = validateManualIncidentUpdateInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      return notifyResolved(append(id, parsed.value.status, parsed.value.message));
    },

    resolve(id, body) {
      return notifyResolved(append(id, "resolved", resolveMessage(body)));
    },

    remove(id) {
      rowOf(id);
      deleteOne.run(id);
    },

    deleteResolvedBefore(cutoff) {
      return Number(deleteOld.run(cutoff).changes);
    },
  };
}
