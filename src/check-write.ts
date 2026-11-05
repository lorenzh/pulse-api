import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type Check, validateAdminCheckInput } from "@lorenzh/pulse-contract";
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
function isMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "keep" && value.keep === true;
}

/** An env reference is exactly `{ "env": "<name>" }`; extra keys are refused, not ignored. */
function isEnvRef(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "env";
}

/** A stored literal header value whose name equals `name` case-insensitively. */
function storedLiteral(stored: Check | undefined, name: string): string | undefined {
  if (stored === undefined || (stored.type !== undefined && stored.type !== "http"))
    return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(stored.headers ?? {})) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return undefined;
}

function storedBody(stored: Check | undefined): string | undefined {
  if (stored === undefined || (stored.type !== undefined && stored.type !== "http"))
    return undefined;
  return stored.body;
}

/** `hasSecret` from a heartbeat view may come back, but only as `true` and only on a heartbeat. */
function dropHasSecret(rest: Record<string, unknown>): void {
  if (!Object.hasOwn(rest, "hasSecret")) return;
  if (rest.type !== "heartbeat" || rest.hasSecret !== true)
    throw invalid("check.hasSecret must be true and only on a heartbeat check");
  delete rest.hasSecret;
}

/** One header value: a literal or env reference as sent, or a keep marker resolved from `stored`. */
function resolvedHeader(name: string, value: unknown, stored: Check | undefined): unknown {
  if (!isRecord(value)) return value;
  if (isEnvRef(value)) return value;
  if (!isMarker(value)) {
    throw invalid(`check.headers.${name}: must be a string, an env reference or a keep marker`);
  }
  const kept = storedLiteral(stored, name);
  if (kept === undefined) throw invalid(`check.headers.${name}: has no stored value to keep`);
  return kept;
}

function resolvedHeaders(
  headers: Record<string, unknown>,
  stored: Check | undefined,
): Record<string, unknown> {
  // fromEntries defines own keys; plain assignment would run the `__proto__` setter and drop it.
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, resolvedHeader(name, value, stored)]),
  );
}

/**
 * Resolve keep markers in header values and the body against the stored definition with the same
 * id; `stored` is undefined on create. Other fields (such as `jsonAssert` data) are literal JSON.
 */
function materialized(
  body: Record<string, unknown>,
  stored: Check | undefined,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...body };
  delete rest.source;
  dropHasSecret(rest);
  if (isMarker(rest.secret)) throw invalid("check.secret: has no stored value to keep");
  if (isRecord(rest.headers)) rest.headers = resolvedHeaders(rest.headers, stored);
  if (isMarker(rest.body)) {
    const kept = storedBody(stored);
    if (kept === undefined) throw invalid("check.body: has no stored value to keep");
    rest.body = kept;
  }
  return rest;
}

/**
 * Stands in for an omitted secret on a heartbeat PUT so that the file rules pass; the stored
 * digest is kept and this value is never stored or compared.
 */
const KEPT_SECRET = "kept-stored-digest";

/** Validate a body with the rules of a checks file entry. Messages never quote a value. */
function parsedBody(
  body: unknown,
  stored: CheckDefinition | null,
): { check: Check; secretSha256: string | null } {
  if (!isRecord(body)) throw invalid("check must be an object");
  if (Object.hasOwn(body, "source") && body.source !== "database") {
    throw invalid('check.source must be "database"');
  }
  // Our own refusals come first for their exact messages; the strict contract check then refuses
  // what the file rules allow, such as runtime fields on a tcp, dns or domain check.
  const strict = validateAdminCheckInput(body);
  const raw = materialized(body, stored?.check);
  if (!strict.ok) throw invalid(strict.error);
  const keepsSecret =
    raw.type === "heartbeat" &&
    raw.secret === undefined &&
    stored !== null &&
    stored.secretSha256 !== null;
  if (keepsSecret) raw.secret = KEPT_SECRET;
  try {
    const { check, secret } = parseCheck(raw, ["check"]);
    if (keepsSecret) return { check, secretSha256: stored.secretSha256 };
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

  /**
   * 409 for a create of an id that the applied file or the store has, for a file-only id, and for
   * a PUT of a shadowed id; 404 for an id in neither. A shadowed id may only be deleted.
   */
  const assertTarget = (action: ConfigAction, id: string): void => {
    const isFile = isFileCheck(id);
    const isStored = store.get(id) !== null;
    if (action === "create") {
      if (isFile || isStored)
        throw new ConfigWriteError("conflict", `check "${id}" already exists`);
      return;
    }
    if (isStored) {
      if (action === "replace" && isFile) {
        throw new ConfigWriteError(
          "conflict",
          `check "${id}" is shadowed by the checks file; only delete is allowed`,
        );
      }
      return;
    }
    if (isFile) {
      throw new ConfigWriteError(
        "conflict",
        `check "${id}" comes from the checks file; edit the file`,
      );
    }
    throw new ConfigWriteError("not-found", `unknown check "${id}"`);
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
    const stored = edit.action === "replace" ? store.get(edit.ref) : null;
    const parsed = edit.action === "delete" ? undefined : parsedBody(edit.body, stored);
    const id = edit.action === "create" ? (parsed?.check.id ?? "") : edit.ref;
    assertTarget(edit.action, id);
    const { generation, definitions, publish } = commit(edit, id, parsed, actor);
    publish();
    holder.setDefinitions(definitions);
    return {
      revision: revision(generation),
      entity: parsed === undefined ? undefined : checkView(parsed.check, "database"),
    };
  };

  return {
    apply: (edit, ifMatch, actor) => deps.lock.run(() => run(edit, ifMatch, actor)),
  };
}
