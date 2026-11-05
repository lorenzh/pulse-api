import type { Database } from "bun:sqlite";
import {
  type InternalManualIncident,
  MANUAL_INCIDENT_MAX_DRAFTS,
  MANUAL_INCIDENT_MAX_NOTES,
  MANUAL_INCIDENT_MAX_UPDATES,
  type ManualIncident,
  type ManualIncidentDraft,
  type ManualIncidentImpact,
  type ManualIncidentNote,
  type ManualIncidentStatus,
  type ManualIncidentUpdate,
  type ManualIncidentVisibility,
  validateManualIncidentDraftInput,
  validateManualIncidentInput,
  validateManualIncidentNoteInput,
  validateManualIncidentUpdateInput,
} from "@lorenzh/pulse-contract";
import type { AuditRecord } from "./audit-log.ts";
import type { Actor } from "./token-store.ts";

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

/** The note id does not name a note of this incident. */
export class ManualIncidentNoteNotFoundError extends Error {
  override name = "ManualIncidentNoteNotFoundError";
}

/** The incident is in a state that refuses the write, or has reached a limit. */
export class ManualIncidentConflictError extends Error {
  override name = "ManualIncidentConflictError";
}

/**
 * The legacy methods (`list`, `get`, `create`, `addUpdate`, `resolve`, `remove`) see only
 * published public incidents: a draft or internal incident is reported as unknown. The other
 * methods serve the private routes and see every incident.
 */
export interface ManualIncidentStore {
  /** Open ones first (newest published first), then up to 50 resolved within 14 days, newest first. */
  list(filter: ManualIncidentFilter): ManualIncident[];
  get(id: number): ManualIncident | undefined;
  /** Each write with an `actor` records its audit entry in the write's transaction. */
  create(body: unknown, actor?: Actor): ManualIncident;
  addUpdate(id: number, body: unknown, actor?: Actor): ManualIncident;
  /** `body` may be undefined or an object with an optional `message`. */
  resolve(id: number, body: unknown, actor?: Actor): ManualIncident;
  remove(id: number, actor?: Actor): void;
  /** Drafts and open incidents (newest created first), then up to 50 recently resolved. */
  listInternal(filter: ManualIncidentFilter): InternalManualIncident[];
  getInternal(id: number): InternalManualIncident | undefined;
  createDraft(body: unknown, actor?: Actor): InternalManualIncident;
  editDraft(id: number, body: unknown, actor?: Actor): InternalManualIncident;
  /** Saves or replaces the draft update of a published, unresolved incident. */
  saveDraftUpdate(id: number, body: unknown, actor?: Actor): InternalManualIncident;
  discardDraftUpdate(id: number, actor?: Actor): void;
  publish(id: number, actor?: Actor): InternalManualIncident;
  /** The note's author is the actor's name. */
  addNote(id: number, body: unknown, actor: Actor): InternalManualIncident;
  deleteNote(id: number, noteId: number, actor?: Actor): void;
  /** Deletes any incident with its updates, draft and notes. */
  removeAny(id: number, actor?: Actor): void;
  /** True when an unresolved published incident (of either visibility) names the component. */
  hasOpenIncidentFor(componentId: string): boolean;
  /** Delete incidents resolved before `cutoff` (epoch ms). Returns how many. */
  deleteResolvedBefore(cutoff: number): number;
}

export interface ManualIncidentDeps {
  now: () => number;
  /** Ids of the configured components, read at every create so a reload takes effect. */
  componentIds: () => ReadonlySet<string>;
  /** Called after commit once per published public incident and once per public resolution. */
  onEvent?: (event: "created" | "resolved") => void;
  /** Inserts one audit entry; it runs inside the write's transaction, so a throw rolls it back. */
  recordAudit?: (entry: AuditRecord) => void;
}

type ManualAuditAction =
  | "manual-incident.create"
  | "manual-incident.update"
  | "manual-incident.resolve"
  | "manual-incident.delete"
  | "manual-incident.edit"
  | "manual-incident.draft-save"
  | "manual-incident.draft-discard"
  | "manual-incident.publish"
  | "manual-incident.note-add"
  | "manual-incident.note-delete";

type IncidentRow = {
  id: number;
  title: string;
  impact: ManualIncidentImpact;
  component_ids_json: string;
  status: ManualIncidentStatus;
  created_at: number;
  resolved_at: number | null;
  visibility: ManualIncidentVisibility;
  published_at: number | null;
};

type UpdateRow = { n: number; at: number; status: ManualIncidentStatus; message: string };
type DraftRow = { status: ManualIncidentStatus; message: string; saved_at: number };
type NoteRow = { id: number; at: number; author: string; message: string };

const PUBLIC = "published_at IS NOT NULL AND visibility = 'public'";

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

/** The first id of `ids` that is not configured, if any. */
function unknownComponent(ids: readonly string[], known: ReadonlySet<string>): string | undefined {
  return ids.find((id) => !known.has(id));
}

function conflict(text: string): ManualIncidentConflictError {
  return new ManualIncidentConflictError(text);
}

const MOST_UPDATES = `manual incident has the most updates it takes (${MANUAL_INCIDENT_MAX_UPDATES})`;

type Event = "created" | "resolved" | undefined;

/** Store of manual incidents. Times come from `now`; update numbers are the row index. */
export function createManualIncidentStore(
  db: Database,
  { now, componentIds, onEvent, recordAudit }: ManualIncidentDeps,
): ManualIncidentStore {
  const insertIncident = db.prepare(
    `INSERT INTO manual_incidents
       (title, impact, component_ids_json, status, created_at, resolved_at, visibility, published_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const updateIncident = db.prepare(
    `UPDATE manual_incidents SET title = ?, impact = ?, component_ids_json = ?, status = ?,
       visibility = ? WHERE id = ?`,
  );
  const insertUpdate = db.prepare(
    "INSERT INTO manual_incident_updates (incident_id, n, at, status, message) VALUES (?, ?, ?, ?, ?)",
  );
  const setStatus = db.prepare(
    "UPDATE manual_incidents SET status = ?, resolved_at = ? WHERE id = ?",
  );
  const setPublished = db.prepare(
    "UPDATE manual_incidents SET status = ?, published_at = ? WHERE id = ?",
  );
  const selectOne = db.prepare("SELECT * FROM manual_incidents WHERE id = ?");
  const selectPublicOne = db.prepare(`SELECT * FROM manual_incidents WHERE id = ? AND ${PUBLIC}`);
  const selectUpdates = db.prepare(
    "SELECT n, at, status, message FROM manual_incident_updates WHERE incident_id = ? ORDER BY n",
  );
  const selectDraft = db.prepare(
    "SELECT status, message, saved_at FROM manual_incident_drafts WHERE incident_id = ?",
  );
  const upsertDraft = db.prepare(
    `INSERT INTO manual_incident_drafts (incident_id, status, message, saved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (incident_id) DO UPDATE SET
       status = excluded.status, message = excluded.message, saved_at = excluded.saved_at`,
  );
  const deleteDraft = db.prepare("DELETE FROM manual_incident_drafts WHERE incident_id = ?");
  const countDrafts = db.prepare(
    "SELECT COUNT(*) AS n FROM manual_incidents WHERE published_at IS NULL",
  );
  const selectNotes = db.prepare(
    "SELECT id, at, author, message FROM manual_incident_notes WHERE incident_id = ? ORDER BY at, id",
  );
  const countNotes = db.prepare(
    "SELECT COUNT(*) AS n FROM manual_incident_notes WHERE incident_id = ?",
  );
  const insertNote = db.prepare(
    "INSERT INTO manual_incident_notes (incident_id, at, author, message) VALUES (?, ?, ?, ?)",
  );
  const deleteNoteRow = db.prepare(
    "DELETE FROM manual_incident_notes WHERE id = ? AND incident_id = ?",
  );
  const selectPublicOpen = db.prepare(
    `SELECT * FROM manual_incidents WHERE ${PUBLIC} AND resolved_at IS NULL
     ORDER BY published_at DESC, id DESC`,
  );
  const selectPublicResolved = db.prepare(
    `SELECT * FROM manual_incidents WHERE ${PUBLIC} AND resolved_at IS NOT NULL AND resolved_at >= ?
     ORDER BY resolved_at DESC, id DESC LIMIT ?`,
  );
  const selectOpen = db.prepare(
    "SELECT * FROM manual_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC",
  );
  const selectResolved = db.prepare(
    `SELECT * FROM manual_incidents WHERE resolved_at IS NOT NULL AND resolved_at >= ?
     ORDER BY resolved_at DESC, id DESC LIMIT ?`,
  );
  const selectPublishedOpen = db.prepare(
    "SELECT component_ids_json FROM manual_incidents WHERE published_at IS NOT NULL AND resolved_at IS NULL",
  );
  const deleteOne = db.prepare("DELETE FROM manual_incidents WHERE id = ?");
  const deleteOld = db.prepare(
    "DELETE FROM manual_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?",
  );

  const updatesOf = (id: number): UpdateRow[] => selectUpdates.all(id) as unknown as UpdateRow[];
  const draftOf = (id: number): DraftRow | null => selectDraft.get(id) as DraftRow | null;

  const toUpdates = (id: number): ManualIncidentUpdate[] =>
    updatesOf(id).map((u) => ({ at: u.at, status: u.status, message: u.message }));

  /** The public view: `createdAt` is the publication time. Only for published rows. */
  const toIncident = (row: IncidentRow): ManualIncident => ({
    id: row.id,
    title: row.title,
    componentIds: parseIds(row.component_ids_json),
    impact: row.impact,
    status: row.status,
    createdAt: row.published_at ?? row.created_at,
    resolvedAt: row.resolved_at,
    updates: toUpdates(row.id),
  });

  const toInternal = (row: IncidentRow): InternalManualIncident => {
    const draft = draftOf(row.id);
    const notes = (selectNotes.all(row.id) as unknown as NoteRow[]).map(
      (n): ManualIncidentNote => ({ id: n.id, at: n.at, author: n.author, message: n.message }),
    );
    const view: ManualIncidentDraft | null =
      draft === null
        ? null
        : { status: draft.status, message: draft.message, savedAt: draft.saved_at };
    return {
      id: row.id,
      title: row.title,
      componentIds: parseIds(row.component_ids_json),
      impact: row.impact,
      visibility: row.visibility,
      status: row.status,
      createdAt: row.created_at,
      publishedAt: row.published_at,
      resolvedAt: row.resolved_at,
      updates: toUpdates(row.id),
      draft: view,
      notes,
    };
  };

  const anyRow = (id: number): IncidentRow => {
    const row = selectOne.get(id) as IncidentRow | null;
    if (!row) throw new ManualIncidentNotFoundError(`unknown manual incident ${id}`);
    return row;
  };

  /** A draft or internal incident is unknown to the legacy writes. */
  const publicRow = (id: number): IncidentRow => {
    const row = selectPublicOne.get(id) as IncidentRow | null;
    if (!row) throw new ManualIncidentNotFoundError(`unknown manual incident ${id}`);
    return row;
  };

  const inTransaction = <T>(fn: () => T): T => {
    db.run("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.run("COMMIT");
      return out;
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  };

  /** Runs `fn` in a transaction, then reports its public event after the commit. */
  const writeWithEvent = <T>(fn: () => { value: T; event: Event }): T => {
    const { value, event } = inTransaction(fn);
    if (event !== undefined) onEvent?.(event);
    return value;
  };

  const audit = (
    at: number,
    actor: Actor | undefined,
    action: ManualAuditAction,
    id: number,
  ): void => {
    if (actor === undefined || recordAudit === undefined) return;
    recordAudit({
      at,
      actor,
      action,
      target: { kind: "manual-incident", id: String(id) },
      revision: null,
    });
  };

  /** Append a published update to an open incident; a resolving update discards the draft. */
  const appendUpdate = (
    row: IncidentRow,
    status: ManualIncidentStatus,
    message: string,
  ): { at: number; event: Event } => {
    const updates = updatesOf(row.id);
    if (updates.length >= MANUAL_INCIDENT_MAX_UPDATES) throw conflict(MOST_UPDATES);
    // Never earlier than the last update, so the order by `at` holds if the clock steps back.
    const at = Math.max(now(), updates.at(-1)?.at ?? 0);
    insertUpdate.run(row.id, updates.length, at, status, message);
    const isResolving = status === "resolved";
    setStatus.run(status, isResolving ? at : null, row.id);
    if (!isResolving) return { at, event: undefined };
    deleteDraft.run(row.id);
    return { at, event: row.visibility === "public" ? "resolved" : undefined };
  };

  /** Legacy append: only published public incidents. */
  const append = (
    id: number,
    status: ManualIncidentStatus,
    message: string,
    actor: Actor | undefined,
    action: ManualAuditAction,
  ): ManualIncident =>
    writeWithEvent(() => {
      const row = publicRow(id);
      if (row.status === "resolved") throw conflict("manual incident is resolved");
      const { at, event } = appendUpdate(row, status, message);
      audit(at, actor, action, id);
      return { value: toIncident(publicRow(id)), event };
    });

  const requireComponents = (ids: readonly string[], toError: (text: string) => Error): void => {
    const missing = unknownComponent(ids, componentIds());
    if (missing !== undefined) throw toError(`componentIds: unknown component "${missing}"`);
  };

  const parseDraftInput = (body: unknown) => {
    const parsed = validateManualIncidentDraftInput(body);
    if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
    const input = parsed.value;
    requireComponents(input.componentIds, (t) => new ManualIncidentInputError(t));
    return { ...input, status: input.status ?? "investigating" };
  };

  /** Rows of an incident that is published and not resolved, for the draft update writes. */
  const openPublishedRow = (id: number): IncidentRow => {
    const row = anyRow(id);
    if (row.published_at === null) throw conflict("manual incident is a draft");
    return row;
  };

  const publishDraftIncident = (
    row: IncidentRow,
    draft: DraftRow,
  ): { at: number; event: Event } => {
    requireComponents(parseIds(row.component_ids_json), conflict);
    const at = now();
    insertUpdate.run(row.id, 0, at, draft.status, draft.message);
    setPublished.run(draft.status, at, row.id);
    return { at, event: row.visibility === "public" ? "created" : undefined };
  };

  return {
    list(filter) {
      const open =
        filter === "resolved" ? [] : (selectPublicOpen.all() as unknown as IncidentRow[]);
      const resolved =
        filter === "open"
          ? []
          : (selectPublicResolved.all(
              now() - RECENT_RESOLVED_MS,
              RECENT_RESOLVED_LIMIT,
            ) as unknown as IncidentRow[]);
      return [...open, ...resolved].map(toIncident);
    },

    get(id) {
      const row = selectPublicOne.get(id) as IncidentRow | null;
      return row ? toIncident(row) : undefined;
    },

    create(body, actor) {
      const parsed = validateManualIncidentInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      const input = parsed.value;
      requireComponents(input.componentIds, (t) => new ManualIncidentInputError(t));
      const at = now();
      const status = input.status ?? "investigating";
      return writeWithEvent(() => {
        const id = Number(
          insertIncident.run(
            input.title,
            input.impact,
            JSON.stringify(input.componentIds),
            status,
            at,
            "public",
            at,
          ).lastInsertRowid,
        );
        insertUpdate.run(id, 0, at, status, input.message);
        audit(at, actor, "manual-incident.create", id);
        return { value: toIncident(publicRow(id)), event: "created" };
      });
    },

    addUpdate(id, body, actor) {
      const parsed = validateManualIncidentUpdateInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      const { status, message } = parsed.value;
      return append(id, status, message, actor, "manual-incident.update");
    },

    resolve(id, body, actor) {
      const message = resolveMessage(body);
      return append(id, "resolved", message, actor, "manual-incident.resolve");
    },

    remove(id, actor) {
      inTransaction(() => {
        publicRow(id);
        deleteOne.run(id);
        audit(now(), actor, "manual-incident.delete", id);
      });
    },

    listInternal(filter) {
      const open = filter === "resolved" ? [] : (selectOpen.all() as unknown as IncidentRow[]);
      const resolved =
        filter === "open"
          ? []
          : (selectResolved.all(
              now() - RECENT_RESOLVED_MS,
              RECENT_RESOLVED_LIMIT,
            ) as unknown as IncidentRow[]);
      return [...open, ...resolved].map(toInternal);
    },

    getInternal(id) {
      const row = selectOne.get(id) as IncidentRow | null;
      return row ? toInternal(row) : undefined;
    },

    createDraft(body, actor) {
      const input = parseDraftInput(body);
      return inTransaction(() => {
        const drafts = (countDrafts.get() as { n: number } | null)?.n ?? 0;
        if (drafts >= MANUAL_INCIDENT_MAX_DRAFTS) {
          throw conflict(`too many draft incidents (${MANUAL_INCIDENT_MAX_DRAFTS})`);
        }
        const at = now();
        const id = Number(
          insertIncident.run(
            input.title,
            input.impact,
            JSON.stringify(input.componentIds),
            input.status,
            at,
            input.visibility,
            null,
          ).lastInsertRowid,
        );
        upsertDraft.run(id, input.status, input.message, at);
        audit(at, actor, "manual-incident.create", id);
        return toInternal(anyRow(id));
      });
    },

    editDraft(id, body, actor) {
      const input = parseDraftInput(body);
      return inTransaction(() => {
        const row = anyRow(id);
        if (row.published_at !== null) throw conflict("manual incident is published");
        const at = now();
        updateIncident.run(
          input.title,
          input.impact,
          JSON.stringify(input.componentIds),
          input.status,
          input.visibility,
          id,
        );
        upsertDraft.run(id, input.status, input.message, at);
        audit(at, actor, "manual-incident.edit", id);
        return toInternal(anyRow(id));
      });
    },

    saveDraftUpdate(id, body, actor) {
      const parsed = validateManualIncidentUpdateInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      const { status, message } = parsed.value;
      return inTransaction(() => {
        const row = openPublishedRow(id);
        if (row.status === "resolved") throw conflict("manual incident is resolved");
        if (updatesOf(id).length >= MANUAL_INCIDENT_MAX_UPDATES) throw conflict(MOST_UPDATES);
        const at = now();
        upsertDraft.run(id, status, message, at);
        audit(at, actor, "manual-incident.draft-save", id);
        return toInternal(anyRow(id));
      });
    },

    discardDraftUpdate(id, actor) {
      inTransaction(() => {
        openPublishedRow(id);
        if (draftOf(id) === null) throw conflict("manual incident has no draft");
        deleteDraft.run(id);
        audit(now(), actor, "manual-incident.draft-discard", id);
      });
    },

    publish(id, actor) {
      return writeWithEvent(() => {
        const row = anyRow(id);
        const draft = draftOf(id);
        if (draft === null) throw conflict("manual incident has no draft");
        const { at, event } =
          row.published_at === null
            ? publishDraftIncident(row, draft)
            : appendUpdate(row, draft.status, draft.message);
        deleteDraft.run(id);
        audit(at, actor, "manual-incident.publish", id);
        return { value: toInternal(anyRow(id)), event };
      });
    },

    addNote(id, body, actor) {
      const parsed = validateManualIncidentNoteInput(body);
      if (!parsed.ok) throw new ManualIncidentInputError(parsed.error);
      const { message } = parsed.value;
      return inTransaction(() => {
        anyRow(id);
        const notes = (countNotes.get(id) as { n: number } | null)?.n ?? 0;
        if (notes >= MANUAL_INCIDENT_MAX_NOTES) {
          throw conflict(
            `manual incident has the most notes it takes (${MANUAL_INCIDENT_MAX_NOTES})`,
          );
        }
        const at = now();
        insertNote.run(id, at, actor.name, message);
        audit(at, actor, "manual-incident.note-add", id);
        return toInternal(anyRow(id));
      });
    },

    deleteNote(id, noteId, actor) {
      inTransaction(() => {
        anyRow(id);
        if (deleteNoteRow.run(noteId, id).changes === 0) {
          throw new ManualIncidentNoteNotFoundError("note not found");
        }
        audit(now(), actor, "manual-incident.note-delete", id);
      });
    },

    removeAny(id, actor) {
      inTransaction(() => {
        anyRow(id);
        deleteOne.run(id);
        audit(now(), actor, "manual-incident.delete", id);
      });
    },

    hasOpenIncidentFor(componentId) {
      return (selectPublishedOpen.all() as unknown as { component_ids_json: string }[]).some(
        (row) => parseIds(row.component_ids_json).includes(componentId),
      );
    },

    deleteResolvedBefore(cutoff) {
      return Number(deleteOld.run(cutoff).changes);
    },
  };
}
