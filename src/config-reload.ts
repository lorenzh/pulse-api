import { createHash } from "node:crypto";
import { ADMIN_REVISION_PREFIX } from "@lorenzh/pulse-contract";
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
  /** Record a file the writer has just stored and applied itself. */
  adopt(bytes: Buffer, config: Config): void;
}

export interface ReloaderDeps {
  path: string;
  fs: ReloadFs;
  /** Swap the configuration in; called only with a valid one. */
  onApply: (config: Config) => void;
  /** Receives the `warn` line of a rejected or failed reload. */
  log: (line: string) => void;
  metrics: Pick<Metrics, "recordConfigReload">;
}

export function revisionOf(bytes: Uint8Array): string {
  return `${ADMIN_REVISION_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
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

/** Name and code of an apply error only: its message can quote values of the file. */
function applyErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const name = SAFE_NAME.test(err.name) ? err.name : "Error";
  const code: unknown = Reflect.get(err, "code");
  return typeof code === "string" && SAFE_CODE.test(code) ? `${name} ${code}` : name;
}

function utf8(bytes: Buffer): string {
  return bytes.toString("utf8");
}

export interface InitialConfig {
  config: Config;
  revision: string;
  stampKey: string | undefined;
}

/** Read and parse the file at startup. Throws ConfigError, which the start maps to a startup error. */
export function loadInitialConfig(fs: ReloadFs, path: string): InitialConfig {
  let bytes: Buffer;
  let key: string | undefined;
  try {
    key = stampKey(fs.stat(path));
    bytes = fs.readFile(path);
  } catch (err) {
    throw new ConfigError(`cannot read checks file ${path}: ${errorCode(err)}`, { cause: err });
  }
  return { config: parseConfigText(path, utf8(bytes)), revision: revisionOf(bytes), stampKey: key };
}

export function createConfigReloader(deps: ReloaderDeps, initial: InitialConfig): ConfigReloader {
  const { path, fs } = deps;
  let revision = initial.revision;
  let lastKey = initial.stampKey;
  // A failed apply must run again on the next poll, even for bytes that match the revision.
  let isRetryPending = false;

  const reject = (message: string): void => {
    deps.metrics.recordConfigReload("invalid");
    deps.log(`config reload rejected: ${path}: ${message}`);
  };

  const apply = (bytes: Buffer, isForced: boolean): void => {
    const next = revisionOf(bytes);
    if (next === revision && !isForced && !isRetryPending) return;
    let config: Config;
    try {
      config = parseConfigText(path, utf8(bytes));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const prefix = `${path}: `;
      reject(err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message);
      return;
    }
    try {
      deps.onApply(config);
    } catch (err) {
      // Leave the stamp unrecorded, so the next poll applies the same bytes again.
      lastKey = undefined;
      isRetryPending = true;
      deps.metrics.recordConfigReload("error");
      deps.log(
        `config reload failed: ${path}: cannot apply the configuration: ${applyErrorText(err)}`,
      );
      return;
    }
    revision = next;
    isRetryPending = false;
    deps.metrics.recordConfigReload("ok");
  };

  const load = (key: string | undefined, isForced: boolean): void => {
    lastKey = key;
    let bytes: Buffer;
    try {
      bytes = fs.readFile(path);
    } catch (err) {
      reject(`cannot read the file (${errorCode(err)})`);
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
      deps.onApply(config);
      revision = revisionOf(bytes);
      isRetryPending = false;
      lastKey = currentKey();
    },
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
