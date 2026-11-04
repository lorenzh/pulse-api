import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Check } from "@lorenzh/pulse-contract";
import { isRecord } from "@lorenzh/pulse-kit";
import type { AuditLog } from "./audit-log.ts";
import type { CheckDefinition, CheckStore } from "./check-store.ts";
import { ConfigError, parseCheck } from "./config.ts";
import type { ConfigHolder } from "./config-holder.ts";
import { adminRevision } from "./config-reload.ts";
import {
  AUDIT_WRITE_FAILED,
  type ConfigAction,
  ConfigWriteError,
  checkView,
  type WriteActor,
  type WriteOutcome,
} from "./config-write.ts";
import { effectiveChecks } from "./effective-checks.ts";
import type { Service } from "./service.ts";
import type { WriteLock } from "./write-lock.ts";

/** A write of one database check. `ref` is the check id of the path. */
export type CheckEdit =
  | { action: "create"; body: unknown }
  | { action: "replace"; ref: string; body: unknown }
  | { action: "delete"; ref: string };

export interface CheckWriterDeps {
  db: Database;
  store: CheckStore;
  service: Pick<Service, "upsertChecks">;
  holder: ConfigHolder;
  /** The revision of the applied checks file. */
  fileRevision: () => string;
  audit: Pick<AuditLog, "record">;
  lock: WriteLock;
  now: () => number;
}

export interface CheckWriter {
  /** One write under the shared lock. `ifMatch` is the unquoted revision the caller based it on. */
  apply(edit: CheckEdit, ifMatch: string, actor: WriteActor): Promise<WriteOutcome>;
}

const STORE_FAILED = "check could not be stored";

function invalid(message: string): ConfigWriteError {
  return new ConfigWriteError("invalid", message);
}

/** A keep marker is exactly `{ "keep": true }`; a header or field named `keep` is not one. */
function isKeepMarker(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "keep" && value.keep === true;
}

function isMarker(value: unknown): boolean {
  return isRecord(value) && isKeepMarker(value);
}

/**
 * True when a field that the admin view redacts holds a keep marker: a header value, the body,
 * or the secret. Other fields (such as `jsonAssert` data) are literal JSON.
 */
function hasKeepMarker(body: Record<string, unknown>): boolean {
  const headers = body.headers;
  if (isRecord(headers) && Object.values(headers).some(isMarker)) return true;
  return isMarker(body.body) || isMarker(body.secret);
}

/** Validate a body with the rules of a checks file entry. Messages never quote a value. */
function parsedBody(body: unknown): { check: Check; secretSha256: string | null } {
  if (!isRecord(body)) throw invalid("check must be an object");
  if (Object.hasOwn(body, "source")) throw invalid("check.source is set by the server");
  if (hasKeepMarker(body)) throw invalid("check must not contain keep markers");
  try {
    const { check, secret } = parseCheck(body, ["check"]);
    const secretSha256 = secret === null ? null : createHash("sha256").update(secret).digest("hex");
    return { check, secretSha256 };
  } catch (err) {
    if (err instanceof ConfigError) throw invalid(err.message);
    throw err;
  }
}

export function createCheckWriter(deps: CheckWriterDeps): CheckWriter {
  const { db, store, holder } = deps;

  const revision = (generation: number): string => adminRevision(deps.fileRevision(), generation);

  const isFileCheck = (id: string): boolean => holder.file().checks.some((c) => c.id === id);

  /** 409 for an id the file owns or a create of a stored id, 404 for an unknown database id. */
  const assertTarget = (action: ConfigAction, id: string): void => {
    if (isFileCheck(id)) {
      throw new ConfigWriteError("conflict", `check "${id}" is defined in the checks file`);
    }
    const isStored = store.get(id) !== null;
    if (action === "create" && isStored) {
      throw new ConfigWriteError("conflict", `check "${id}" already exists`);
    }
    if (action !== "create" && !isStored) {
      throw new ConfigWriteError("not-found", `unknown check "${id}"`);
    }
  };

  const storeEdit = (edit: CheckEdit, parsed: ReturnType<typeof parsedBody> | undefined): void => {
    if (edit.action === "delete") {
      store.delete(edit.ref);
      return;
    }
    if (parsed === undefined) throw new TypeError("a create or replace needs a body");
    if (edit.action === "create") store.create(parsed.check, parsed.secretSha256);
    else store.replace(parsed.check, parsed.secretSha256);
  };

  /** Definition, generation, runtime rows and audit entry commit together or not at all. */
  const commit = (
    edit: CheckEdit,
    id: string,
    parsed: ReturnType<typeof parsedBody> | undefined,
    actor: WriteActor,
  ): { generation: number; definitions: CheckDefinition[]; publish: () => void } => {
    let isAuditStep = false;
    try {
      return db.transaction(() => {
        storeEdit(edit, parsed);
        const generation = store.bumpGeneration();
        const definitions = store.list();
        const { checks } = effectiveChecks(
          { checks: holder.file().checks, secretDigests: new Map() },
          definitions,
        );
        const publish = deps.service.upsertChecks(checks);
        isAuditStep = true;
        deps.audit.record({
          at: deps.now(),
          actor,
          action: `check.${edit.action}`,
          target: { kind: "check", id },
          revision: revision(generation),
        });
        return { generation, definitions, publish };
      })();
    } catch (err) {
      throw new ConfigWriteError("error", isAuditStep ? AUDIT_WRITE_FAILED : STORE_FAILED, {
        cause: err,
      });
    }
  };

  const run = (edit: CheckEdit, ifMatch: string, actor: WriteActor): WriteOutcome => {
    if (revision(store.generation()) !== ifMatch) {
      throw new ConfigWriteError("stale", "the configuration changed: reload it and retry");
    }
    const parsed = edit.action === "delete" ? undefined : parsedBody(edit.body);
    const id = edit.action === "create" ? (parsed?.check.id ?? "") : edit.ref;
    assertTarget(edit.action, id);
    const { generation, definitions, publish } = commit(edit, id, parsed, actor);
    publish();
    holder.setDefinitions(definitions);
    return {
      revision: revision(generation),
      entity: parsed === undefined ? undefined : checkView(parsed.check, "database"),
      index: undefined,
    };
  };

  return {
    apply: (edit, ifMatch, actor) => deps.lock.run(() => run(edit, ifMatch, actor)),
  };
}
