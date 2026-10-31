import { dirname } from "node:path";
import type {
  AdminCheckView,
  AdminComponent,
  AdminConfigResponse,
  AdminMaintenanceView,
  AdminWriteResponse,
  Check,
} from "@lorenzh/pulse-contract";
import { type AtomicWriteSyncFs, isRecord, writeFileAtomicSync } from "@lorenzh/pulse-kit";
import { type Config, ConfigError, parseConfig } from "./config.ts";
import type { ConfigHolder } from "./config-holder.ts";
import { type ConfigReloader, revisionOf } from "./config-reload.ts";

export type ConfigKind = "check" | "component" | "maintenance";
export type ConfigAction = "create" | "replace" | "delete";

/** What the writer does to the checks file. `ref` is a check or component id, or a window index. */
export type ConfigEdit =
  | { kind: ConfigKind; action: "create"; body: unknown }
  | { kind: ConfigKind; action: "replace"; ref: string | number; body: unknown }
  | { kind: ConfigKind; action: "delete"; ref: string | number };

/** Why a write failed; the HTTP layer maps `code` to a status. */
export type WriteFailure = "stale" | "invalid" | "conflict" | "not-found" | "readonly" | "error";

export class ConfigWriteError extends Error {
  override name = "ConfigWriteError";
  readonly code: WriteFailure;
  constructor(code: WriteFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** The file operations of a write. Every step may throw an error with a Node `code`. */
export interface WriteFs {
  readFile(path: string): Buffer;
  /** Temp file, rename and directory fsync of the atomic write; keeps mode and owner. */
  atomic: AtomicWriteSyncFs;
  /** Throws when `dir` is not writable. */
  assertWritable(dir: string): void;
}

export interface WriterDeps {
  path: string;
  fs: WriteFs;
  holder: ConfigHolder;
  reloader: Pick<ConfigReloader, "revision" | "adopt">;
  /** A unique file name part for the temp file. */
  tempSuffix: () => string;
  /** True when an unresolved manual incident names the component. */
  hasOpenIncidentFor: (componentId: string) => boolean;
}

export interface WriteOutcome {
  revision: string;
  /** The stored entity, redacted; absent after a delete. */
  entity: AdminWriteResponse | undefined;
  /** Position of a created or replaced maintenance window. */
  index: number | undefined;
}

export interface ConfigWriter {
  /** The applied configuration without secrets, with its revision. */
  view(): AdminConfigResponse;
  /** Throws a `readonly` ConfigWriteError when the directory cannot take a new file. */
  assertWritable(): void;
  /** One write under the lock. `ifMatch` is the unquoted revision the caller based it on. */
  apply(edit: ConfigEdit, ifMatch: string): Promise<WriteOutcome>;
}

const READONLY_CODES: ReadonlySet<string> = new Set(["EROFS", "EACCES", "EPERM", "EBUSY", "EXDEV"]);

function codeOf(err: unknown): string {
  const code = err instanceof Error ? Reflect.get(err, "code") : undefined;
  return typeof code === "string" ? code : "unknown";
}

/** Map a failed file step. The message names the cause by code, never the path or content. */
function mapFsError(err: unknown): ConfigWriteError {
  if (err instanceof ConfigWriteError) return err;
  const code = codeOf(err);
  if (READONLY_CODES.has(code)) {
    return new ConfigWriteError("readonly", `checks file is read-only (${code})`, { cause: err });
  }
  return new ConfigWriteError("error", `checks file could not be written (${code})`, {
    cause: err,
  });
}

/** The check as served: header names only, no body, no secret. */
export function checkView(check: Check): AdminCheckView {
  switch (check.type) {
    case "heartbeat":
      return { ...check, hasSecret: true as const };
    case "tls":
    case "tcp":
    case "dns":
    case "domain":
      return { ...check };
    case undefined:
    case "http": {
      const { headers, body, ...rest } = check;
      return {
        ...rest,
        ...(headers === undefined ? {} : { headers: Object.keys(headers) }),
        ...(body === undefined ? {} : { hasBody: true }),
      };
    }
    default: {
      const never: never = check;
      return never;
    }
  }
}

export function configView(config: Config, revision: string): AdminConfigResponse {
  return {
    revision,
    checks: config.checks.map(checkView),
    components: config.components.map((c) => ({ ...c })),
    maintenance: config.maintenance.map((w, index) => ({ ...w, index })),
  };
}

type Doc = Record<string, unknown>;

function listOf(doc: Doc, key: "checks" | "components" | "maintenance"): unknown[] {
  const list = doc[key];
  if (Array.isArray(list)) return list;
  const created: unknown[] = [];
  doc[key] = created;
  return created;
}

function idOf(item: unknown): unknown {
  return isRecord(item) ? item.id : undefined;
}

function invalid(message: string): ConfigWriteError {
  return new ConfigWriteError("invalid", message);
}

function parseDoc(bytes: Buffer): Doc {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new ConfigWriteError("error", "checks file is not valid JSON", { cause: err });
  }
  if (!isRecord(doc)) throw new ConfigWriteError("error", "checks file is not an object");
  return doc;
}

/** Window times may come as epoch ms (the contract's form); the file holds ISO strings. */
function windowBody(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const out: Doc = { ...body };
  for (const key of ["start", "end"]) {
    const v = out[key];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 8.64e15) {
      out[key] = new Date(v).toISOString();
    }
  }
  return out;
}

/** Run the file parsers on the candidate; a failure is a 422. Messages never quote values. */
function validated(doc: Doc): Config {
  try {
    return parseConfig(doc);
  } catch (err) {
    if (err instanceof ConfigError) throw invalid(err.message);
    throw err;
  }
}

function mustBeObject(kind: ConfigKind, body: unknown): Doc {
  if (!isRecord(body)) throw invalid(`${kind} must be an object`);
  return body;
}

/** Keep the stored secret on a heartbeat replace that sends none. */
function keepSecret(old: unknown, body: Doc): Doc {
  if (!isRecord(old) || old.type !== "heartbeat" || body.type !== "heartbeat") return body;
  if (body.secret !== undefined || old.secret === undefined) return body;
  return { ...body, secret: old.secret };
}

/** The list a kind lives in, and how its entries are addressed. */
const LIST_KEY = { check: "checks", component: "components", maintenance: "maintenance" } as const;

function listKey(kind: ConfigKind): "checks" | "components" | "maintenance" {
  return LIST_KEY[kind];
}

function locate(kind: ConfigKind, list: unknown[], ref: string | number): number {
  if (kind === "maintenance") {
    return typeof ref === "number" && Number.isInteger(ref) && ref >= 0 && ref < list.length
      ? ref
      : -1;
  }
  return list.findIndex((item) => idOf(item) === ref);
}

function referenceOf(doc: Doc, checkId: string): string | undefined {
  const components = Array.isArray(doc.components) ? doc.components : [];
  for (const c of components) {
    const ids = isRecord(c) && Array.isArray(c.checkIds) ? c.checkIds : [];
    if (ids.includes(checkId)) return `component "${String(idOf(c))}"`;
  }
  const windows = Array.isArray(doc.maintenance) ? doc.maintenance : [];
  const at = windows.findIndex((w) => isRecord(w) && w.checkId === checkId);
  return at >= 0 ? `maintenance[${at}]` : undefined;
}

interface Applied {
  doc: Doc;
  /** Index of the touched entry in its list; the end of the list after a create. */
  index: number;
}

/** The request body of a create or replace, in the shape of the file. */
function fileBody(kind: ConfigKind, raw: unknown): Doc {
  return mustBeObject(kind, kind === "maintenance" ? windowBody(raw) : raw);
}

function createEntry(edit: ConfigEdit, doc: Doc): Applied {
  if (edit.action !== "create") throw new TypeError("not a create");
  const { kind } = edit;
  const body = fileBody(kind, edit.body);
  const list = listOf(doc, listKey(kind));
  const existing = kind === "maintenance" ? -1 : list.findIndex((i) => idOf(i) === body.id);
  if (existing < 0) {
    list.push(body);
    return { doc, index: list.length - 1 };
  }
  // Validate first: a bad body is a 422 also when its id exists.
  const probe = { ...doc, [listKey(kind)]: list.map((item, i) => (i === existing ? body : item)) };
  validated(probe);
  throw new ConfigWriteError("conflict", `${kind} "${String(body.id)}" already exists`);
}

function replaceEntry(edit: ConfigEdit, doc: Doc): Applied {
  if (edit.action !== "replace") throw new TypeError("not a replace");
  const { kind } = edit;
  const key = listKey(kind);
  const list = listOf(doc, key);
  const given = fileBody(kind, edit.body);
  const at = locate(kind, list, edit.ref);
  if (at < 0) {
    // Validate first: a bad body is a 422 also when the id is unknown.
    validated({ ...doc, [key]: [...list, given] });
    throw new ConfigWriteError("not-found", `unknown ${kind} ${notFoundRef(kind, edit.ref)}`);
  }
  list[at] = kind === "check" ? keepSecret(list[at], given) : given;
  return { doc, index: at };
}

function notFoundRef(kind: ConfigKind, ref: string | number): string {
  return kind === "maintenance" ? `index ${String(ref)}` : `"${String(ref)}"`;
}

function deleteEntry(
  edit: ConfigEdit,
  doc: Doc,
  hasOpenIncidentFor: (id: string) => boolean,
): Applied {
  if (edit.action !== "delete") throw new TypeError("not a delete");
  const { kind, ref } = edit;
  const list = listOf(doc, listKey(kind));
  const at = locate(kind, list, ref);
  if (at < 0) throw new ConfigWriteError("not-found", `unknown ${kind} ${notFoundRef(kind, ref)}`);
  if (kind === "check") {
    const holder = referenceOf(doc, String(ref));
    if (holder !== undefined) {
      throw new ConfigWriteError("conflict", `check "${String(ref)}" is still used by ${holder}`);
    }
  }
  if (kind === "component" && hasOpenIncidentFor(String(ref))) {
    throw new ConfigWriteError(
      "conflict",
      `component "${String(ref)}" is named by an unresolved manual incident`,
    );
  }
  list.splice(at, 1);
  return { doc, index: at };
}

function applyEdit(edit: ConfigEdit, doc: Doc, hasOpen: (id: string) => boolean): Applied {
  switch (edit.action) {
    case "create":
      return createEntry(edit, doc);
    case "replace":
      return replaceEntry(edit, doc);
    case "delete":
      return deleteEntry(edit, doc, hasOpen);
    default: {
      const never: never = edit;
      return never;
    }
  }
}

function entityOf(edit: ConfigEdit, config: Config, index: number): AdminWriteResponse | undefined {
  if (edit.action === "delete") return undefined;
  switch (edit.kind) {
    case "check": {
      const check = config.checks[index];
      return check === undefined ? undefined : checkView(check);
    }
    case "component": {
      const component: AdminComponent | undefined = config.components[index];
      return component === undefined ? undefined : { ...component };
    }
    case "maintenance": {
      const window = config.maintenance[index];
      const view: AdminMaintenanceView | undefined =
        window === undefined ? undefined : { ...window, index };
      return view;
    }
    default: {
      const never: never = edit.kind;
      return never;
    }
  }
}

export function createConfigWriter(deps: WriterDeps): ConfigWriter {
  const { path, fs } = deps;
  const dir = dirname(path);
  let tail: Promise<unknown> = Promise.resolve();

  const readBytes = (): Buffer => {
    try {
      return fs.readFile(path);
    } catch (err) {
      throw mapFsError(err);
    }
  };

  const assertCurrent = (ifMatch: string): Buffer => {
    const bytes = readBytes();
    if (revisionOf(bytes) !== ifMatch) {
      throw new ConfigWriteError("stale", "the checks file changed: reload it and retry");
    }
    return bytes;
  };

  /** Temp file, fsync, a second revision check, rename, fsync of the directory, then apply. */
  const store = (data: Buffer, ifMatch: string, config: Config): void => {
    try {
      writeFileAtomicSync(path, data, {
        fs: fs.atomic,
        tempSuffix: deps.tempSuffix,
        beforeRename: () => {
          // An external writer racing after this check stays possible.
          assertCurrent(ifMatch);
          return true;
        },
      });
    } catch (err) {
      throw mapFsError(err);
    }
    try {
      deps.reloader.adopt(data, config);
    } catch (err) {
      // The file is stored and stays the source of truth: the running config and revision are
      // unchanged, and the next reload applies the file.
      throw new ConfigWriteError(
        "error",
        `checks file stored, but applying it failed (${codeOf(err)}); the next reload applies it`,
        { cause: err },
      );
    }
  };

  const run = (edit: ConfigEdit, ifMatch: string): WriteOutcome => {
    const doc = parseDoc(assertCurrent(ifMatch));
    const { index } = applyEdit(edit, doc, deps.hasOpenIncidentFor);
    const config = validated(doc);
    const data = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
    store(data, ifMatch, config);
    return { revision: revisionOf(data), entity: entityOf(edit, config, index), index };
  };

  return {
    view: () => configView(deps.holder.get(), deps.reloader.revision()),
    assertWritable() {
      try {
        fs.assertWritable(dir);
      } catch (err) {
        throw mapFsError(err);
      }
    },
    apply(edit, ifMatch) {
      const result = tail.then(() => run(edit, ifMatch));
      // The chain goes on after a failure.
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
