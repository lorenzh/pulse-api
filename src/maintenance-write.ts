import type { Database } from "bun:sqlite";
import {
  type AdminMaintenanceList,
  type AdminMaintenancePhase,
  type AdminMaintenanceWindow,
  type AdminMaintenanceWindowInput,
  validateAdminMaintenanceWindowInput,
} from "@lorenzh/pulse-contract";
import type { AuditLog } from "./audit-log.ts";
import type { CheckStore } from "./check-store.ts";
import type { FileMaintenanceWindow } from "./config.ts";
import type { ConfigHolder } from "./config-holder.ts";
import { adminRevision } from "./config-reload.ts";
import {
  AUDIT_WRITE_FAILED,
  ConfigWriteError,
  type WriteActor,
  type WriteOutcome,
} from "./config-write.ts";
import type { EffectiveMaintenance } from "./effective-maintenance.ts";
import type { MaintenanceStore, WindowDefinition } from "./maintenance-store.ts";
import type { WriteLock } from "./write-lock.ts";

/** A write of one database window. `ref` is the decoded path segment. */
export type WindowEdit =
  | { action: "create"; body: unknown }
  | { action: "replace"; ref: string; body: unknown }
  | { action: "delete"; ref: string };

export interface MaintenanceWriterDeps {
  db: Database;
  store: MaintenanceStore;
  /** The database generation is shared with the check writer. */
  generation: Pick<CheckStore, "generation" | "bumpGeneration">;
  holder: ConfigHolder;
  /** The revision of the applied checks file; the file on disk is never read. */
  fileRevision: () => string;
  audit: Pick<AuditLog, "record">;
  lock: WriteLock;
  now: () => number;
}

export interface MaintenanceWriter {
  /** One write under the shared lock. `ifMatch` is the unquoted revision the caller based it on. */
  apply(edit: WindowEdit, ifMatch: string, actor: WriteActor): Promise<WriteOutcome>;
}

/** Stored database windows, effective plus shadowed. */
export const MAX_DATABASE_WINDOWS = 1000;

const STORE_FAILED = "maintenance could not be stored";
/** An old window index: never a window id, which starts with a letter. */
const INDEX_REF = /^\d{1,9}$/;

/** Derived from the clock at read time; the window is half-open. */
export function maintenancePhase(start: number, end: number, now: number): AdminMaintenancePhase {
  if (now < start) return "planned";
  return now < end ? "current" : "past";
}

/** The admin view of a database window. */
export function databaseWindowView(w: WindowDefinition, now: number): AdminMaintenanceWindow {
  return {
    id: w.id,
    index: null,
    source: "database",
    checkIds: [...w.checkIds],
    start: w.start,
    end: w.end,
    note: w.note,
    phase: maintenancePhase(w.start, w.end, now),
  };
}

/** The admin view of a file window: read-only, addressed by its position in the applied file. */
function fileWindowView(
  w: FileMaintenanceWindow,
  index: number,
  now: number,
): AdminMaintenanceWindow {
  return {
    id: w.id ?? null,
    index,
    source: "file",
    checkIds: [w.checkId],
    start: w.start,
    end: w.end,
    note: w.note,
    phase: maintenancePhase(w.start, w.end, now),
  };
}

/** `GET /admin/maintenance`: file windows in file order, then the unshadowed database windows. */
export function maintenanceList(
  revision: string,
  file: readonly FileMaintenanceWindow[],
  windows: EffectiveMaintenance,
  now: number,
): AdminMaintenanceList {
  return {
    revision,
    windows: [
      ...file.map((w, index) => fileWindowView(w, index, now)),
      ...windows.effective.map((w) => databaseWindowView(w, now)),
    ],
    shadowed: windows.shadowed.map((w) => databaseWindowView(w, now)),
  };
}

function conflict(message: string): ConfigWriteError {
  return new ConfigWriteError("conflict", message);
}

/** Strict contract validation; the message names a field path, never the note. */
function parsedBody(body: unknown): AdminMaintenanceWindowInput {
  const v = validateAdminMaintenanceWindowInput(body, "maintenance");
  if (!v.ok) throw new ConfigWriteError("invalid", v.error);
  return v.value;
}

export function createMaintenanceWriter(deps: MaintenanceWriterDeps): MaintenanceWriter {
  const { db, store, holder } = deps;

  const revision = (generation: number): string => adminRevision(deps.fileRevision(), generation);

  const fileWindows = () => holder.file().maintenance;
  const isFileId = (id: string): boolean => fileWindows().some((w) => w.id === id);

  const assertReferences = (input: AdminMaintenanceWindowInput): void => {
    const effective = new Set(holder.get().checks.map((c) => c.id));
    input.checkIds.forEach((id, j) => {
      if (!effective.has(id)) {
        throw new ConfigWriteError(
          "invalid",
          `maintenance.checkIds[${j}] must reference a configured check`,
        );
      }
    });
  };

  const assertCreate = (id: string): void => {
    if (isFileId(id) || store.get(id) !== null) {
      throw conflict(`maintenance "${id}" already exists`);
    }
    if (store.count() >= MAX_DATABASE_WINDOWS) {
      throw conflict("too many maintenance windows: delete past ones");
    }
  };

  /** 409 for file-only ids, a shadowed replace and an old file index; 404 for anything else. */
  const assertExisting = (action: "replace" | "delete", ref: string): void => {
    const isFile = isFileId(ref);
    if (store.get(ref) !== null) {
      if (action === "replace" && isFile) {
        throw conflict(
          `maintenance "${ref}" is shadowed by the checks file; only delete is allowed`,
        );
      }
      return;
    }
    if (isFile) throw conflict(`maintenance "${ref}" comes from the checks file; edit the file`);
    if (INDEX_REF.test(ref) && Number(ref) < fileWindows().length) {
      throw conflict("file maintenance windows are read-only; edit the checks file");
    }
    throw new ConfigWriteError("not-found", `unknown maintenance "${ref}"`);
  };

  const storeEdit = (edit: WindowEdit, input: AdminMaintenanceWindowInput | undefined): void => {
    if (edit.action === "delete") {
      store.delete(edit.ref);
      return;
    }
    if (input === undefined) throw new TypeError("a create or replace needs a body");
    if (edit.action === "create") store.create(input);
    else store.replace(input);
  };

  /** Definition, generation and audit entry commit together or not at all. */
  const commit = (
    edit: WindowEdit,
    id: string,
    input: AdminMaintenanceWindowInput | undefined,
    actor: WriteActor,
  ): { generation: number; definitions: WindowDefinition[] } => {
    let isAuditStep = false;
    try {
      return db.transaction(() => {
        storeEdit(edit, input);
        const generation = deps.generation.bumpGeneration();
        const definitions = store.list();
        isAuditStep = true;
        deps.audit.record({
          at: deps.now(),
          actor,
          action: `maintenance.${edit.action}`,
          target: { kind: "maintenance", id },
          revision: revision(generation),
        });
        return { generation, definitions };
      })();
    } catch (err) {
      throw new ConfigWriteError("error", isAuditStep ? AUDIT_WRITE_FAILED : STORE_FAILED, {
        cause: err,
      });
    }
  };

  const run = (edit: WindowEdit, ifMatch: string, actor: WriteActor): WriteOutcome => {
    if (revision(deps.generation.generation()) !== ifMatch) {
      throw new ConfigWriteError("stale", "the configuration changed: reload it and retry");
    }
    const input = edit.action === "delete" ? undefined : parsedBody(edit.body);
    if (edit.action === "replace" && input !== undefined && input.id !== edit.ref) {
      throw new ConfigWriteError("invalid", "maintenance.id must equal the path id");
    }
    if (input !== undefined) assertReferences(input);
    const id = input?.id ?? (edit.action === "delete" ? edit.ref : "");
    if (edit.action === "create") assertCreate(id);
    else assertExisting(edit.action, id);
    const { generation, definitions } = commit(edit, id, input, actor);
    holder.setWindowDefinitions(definitions);
    const stored = definitions.find((d) => d.id === id);
    return {
      revision: revision(generation),
      entity:
        edit.action === "delete" || stored === undefined
          ? undefined
          : databaseWindowView(stored, deps.now()),
    };
  };

  return {
    apply: (edit, ifMatch, actor) => deps.lock.run(() => run(edit, ifMatch, actor)),
  };
}
