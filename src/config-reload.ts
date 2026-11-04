import { createHash } from "node:crypto";
import { ADMIN_REVISION_PREFIX, type AdminFileStatus } from "@lorenzh/pulse-contract";
import { type Config, ConfigError, parseConfigText } from "./config.ts";
import type { Metrics } from "./metrics.ts";

export interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

/** The file operations the reload needs. An idle poll calls `stat` only. */
export interface ReloadFs {
  stat(path: string): FileStamp;
  readFile(path: string): Buffer;
}

export interface ConfigReloader {
  /** `sha256-<hex>` of the bytes of the applied file. */
  revision(): string;
  /** One poll: a `stat`, and a read and hash only when the stamp changed. */
  poll(): void;
  /** Read, hash and apply the file now, whatever its stamp says (SIGHUP). */
  reloadNow(): void;
  /** Apply a file the writer has just stored; a failed apply leaves it written-not-applied. */
  adopt(bytes: Buffer, config: Config): void;
  /** State of the last read or apply of the file, and the time of the last apply. */
  fileStatus(): AdminFileStatus;
}

/** The revision and time of a successful apply, handed to `onApply`. */
export interface AppliedFile {
  revision: string;
  appliedAt: number;
}

export interface ReloaderDeps {
  path: string;
  fs: ReloadFs;
  /** Swap the configuration in; called only with a valid one. */
  onApply: (config: Config, applied: AppliedFile) => void;
  now: () => number;
  /** Receives the `warn` line of a rejected or failed reload. */
  log: (line: string) => void;
  metrics: Pick<Metrics, "recordConfigReload">;
}

export function revisionOf(bytes: Uint8Array): string {
  return `${ADMIN_REVISION_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The admin revision: one value for the applied file and the database check definitions.
 * `sha256-` + hex SHA-256 of `<applied file revision>\n<database generation>`.
 */
export function adminRevision(fileRevision: string, generation: number): string {
  return revisionOf(Buffer.from(`${fileRevision}\n${generation}`, "utf8"));
}

function stampKey(stamp: FileStamp): string {
  return `${stamp.mtimeMs}:${stamp.size}:${stamp.ino}`;
}

function errorCode(err: unknown): string {
  const code = err instanceof Error ? Reflect.get(err, "code") : undefined;
  return typeof code === "string" ? code : "unknown error";
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

/** A data property along the prototype chain; an accessor is never called, since it could return file values. */
function dataProperty(obj: object, key: string): unknown {
  for (let o: object | null = obj; o !== null; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d !== undefined) return "value" in d ? d.value : undefined;
  }
  return undefined;
}

/** Name and code of an apply error only: its message can quote values of the file. */
function applyErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const rawName = dataProperty(err, "name");
  const name = typeof rawName === "string" && SAFE_NAME.test(rawName) ? rawName : "Error";
  const code = dataProperty(err, "code");
  return typeof code === "string" && SAFE_CODE.test(code) ? `${name} ${code}` : name;
}

function utf8(bytes: Buffer): string {
  return bytes.toString("utf8");
}

export interface InitialConfig {
  config: Config;
  revision: string;
  stampKey: string | undefined;
  /** Time of the apply of `config`; defaults to 0. */
  appliedAt?: number;
  /** State of the file at start when it is not the applied one; defaults to ok. */
  status?: { state: Exclude<AdminFileStatus["state"], "ok">; message: string };
}

/** A start whose file could not be read or parsed; `message` is safe and has no path. */
export interface RejectedInitial {
  error: ConfigError;
  state: "invalid" | "unreadable";
  message: string;
  stampKey: string | undefined;
}

/** The parser message without the path: a leading `<path>: ` and the path inside the JSON error. */
function withoutPath(path: string, message: string): string {
  const prefix = `${path}: `;
  const rest = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return rest.replaceAll(` ${path}`, "");
}

/** Read and parse the file at startup; a failure is returned, never thrown. */
export function readInitialConfig(
  fs: ReloadFs,
  path: string,
): { ok: true; initial: InitialConfig } | ({ ok: false } & RejectedInitial) {
  let bytes: Buffer;
  let key: string | undefined;
  try {
    key = stampKey(fs.stat(path));
    bytes = fs.readFile(path);
  } catch (err) {
    return {
      ok: false,
      error: new ConfigError(`cannot read checks file ${path}: ${errorCode(err)}`, { cause: err }),
      state: "unreadable",
      message: `cannot read the file (${errorCode(err)})`,
      stampKey: key,
    };
  }
  try {
    const config = parseConfigText(path, utf8(bytes));
    return { ok: true, initial: { config, revision: revisionOf(bytes), stampKey: key } };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return {
      ok: false,
      error: err,
      state: "invalid",
      message: withoutPath(path, err.message),
      stampKey: key,
    };
  }
}

/** Read and parse the file at startup. Throws ConfigError, which the start maps to a startup error. */
export function loadInitialConfig(fs: ReloadFs, path: string): InitialConfig {
  const read = readInitialConfig(fs, path);
  if (!read.ok) throw read.error;
  return read.initial;
}

export function createConfigReloader(deps: ReloaderDeps, initial: InitialConfig): ConfigReloader {
  const { path, fs } = deps;
  let revision = initial.revision;
  let lastKey = initial.stampKey;
  // A failed apply must run again on the next poll, even for bytes that match the revision.
  let isRetryPending = false;
  let lastAppliedAt = initial.appliedAt ?? 0;
  let status: { state: AdminFileStatus["state"]; message: string | null } = initial.status ?? {
    state: "ok",
    message: null,
  };
  // The same failure is logged once, not at every poll that meets it again.
  let lastWarning: string | undefined;

  const warnOnce = (line: string): void => {
    if (line !== lastWarning) deps.log(line);
    lastWarning = line;
  };

  const reject = (state: "invalid" | "unreadable", message: string): void => {
    status = { state, message };
    deps.metrics.recordConfigReload("invalid");
    warnOnce(`config reload rejected: ${path}: ${message}`);
  };

  const applied = (next: string, at: number): void => {
    revision = next;
    lastAppliedAt = at;
    isRetryPending = false;
    status = { state: "ok", message: null };
    lastWarning = undefined;
  };

  /** Run the apply; on failure the file is written-not-applied and the next poll retries it. */
  const tryApply = (config: Config, next: string): boolean => {
    const at = deps.now();
    try {
      deps.onApply(config, { revision: next, appliedAt: at });
    } catch (err) {
      // Leave the stamp unrecorded, so the next poll applies the same bytes again.
      lastKey = undefined;
      isRetryPending = true;
      const message = `cannot apply the configuration: ${applyErrorText(err)}`;
      status = { state: "written-not-applied", message };
      deps.metrics.recordConfigReload("error");
      warnOnce(`config reload failed: ${path}: ${message}`);
      return false;
    }
    applied(next, at);
    return true;
  };

  const apply = (bytes: Buffer, isForced: boolean): void => {
    const next = revisionOf(bytes);
    // Identical bytes after a failure still apply, so the failure state clears.
    if (next === revision && !isForced && !isRetryPending && status.state === "ok") return;
    let config: Config;
    try {
      config = parseConfigText(path, utf8(bytes));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      reject("invalid", withoutPath(path, err.message));
      return;
    }
    if (tryApply(config, next)) deps.metrics.recordConfigReload("ok");
  };

  const load = (key: string | undefined, isForced: boolean): void => {
    lastKey = key;
    let bytes: Buffer;
    try {
      bytes = fs.readFile(path);
    } catch (err) {
      reject("unreadable", `cannot read the file (${errorCode(err)})`);
      return;
    }
    apply(bytes, isForced);
  };

  const currentKey = (): string => {
    try {
      return stampKey(fs.stat(path));
    } catch (err) {
      return `error:${errorCode(err)}`;
    }
  };

  return {
    revision: () => revision,
    poll() {
      const key = currentKey();
      if (key === lastKey) return;
      load(key, false);
    },
    reloadNow() {
      load(currentKey(), true);
    },
    adopt(bytes, config) {
      const next = revisionOf(bytes);
      const at = deps.now();
      try {
        deps.onApply(config, { revision: next, appliedAt: at });
      } catch (err) {
        // The stored file is valid but not in use: the next poll applies it again.
        lastKey = undefined;
        isRetryPending = true;
        status = {
          state: "written-not-applied",
          message: `cannot apply the configuration: ${applyErrorText(err)}`,
        };
        throw err;
      }
      applied(next, at);
      lastKey = currentKey();
    },
    fileStatus: (): AdminFileStatus => ({ ...status, lastAppliedAt }),
  };
}

export interface PollDeps {
  reloader: Pick<ConfigReloader, "poll">;
  intervalMs: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (line: string) => void;
}

/** Poll every `intervalMs`; 0 starts nothing. The next poll is scheduled after one ends. */
export function startConfigPolling(deps: PollDeps): { stop(): void } {
  if (deps.intervalMs === 0) return { stop: () => undefined };
  let isStopped = false;
  let handle: unknown;
  const run = (): void => {
    try {
      deps.reloader.poll();
    } catch (err) {
      deps.log(`config poll failed: ${err instanceof Error ? err.name : "error"}`);
    }
    if (!isStopped) handle = deps.setTimeout(run, deps.intervalMs);
  };
  handle = deps.setTimeout(run, deps.intervalMs);
  return {
    stop() {
      isStopped = true;
      if (handle !== undefined) deps.clearTimeout(handle);
    },
  };
}
