import { Database } from "bun:sqlite";
import { linkSync, lstatSync, mkdtempSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readString } from "@lorenzh/pulse-kit";

const BACKUP_USAGE = "usage: bun run backup <target-file>";

/** A failed backup. `exitCode` is 2 for a usage error or an existing target, else 1. */
export class BackupError extends Error {
  override name = "BackupError";
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2, options?: ErrorOptions) {
    super(message, options);
    this.exitCode = exitCode;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): unknown {
  return err instanceof Error && "code" in err ? err.code : undefined;
}

/** lstat, so a symlink (also a dangling one) at the target counts as existing. */
function assertTargetFree(target: string): void {
  try {
    lstatSync(target);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return;
    throw new BackupError(`cannot check target ${target}: ${messageOf(err)}`, 1, { cause: err });
  }
  throw new BackupError(`target ${target} exists; choose a new file name`, 2);
}

function assertIsKind(path: string, kind: "file" | "directory", what: string): void {
  let isKind = false;
  try {
    const stat = statSync(path);
    isKind = kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch (err) {
    throw new BackupError(`${what} ${path} does not exist: ${messageOf(err)}`, 1, { cause: err });
  }
  if (!isKind) throw new BackupError(`${what} ${path} is not a ${kind}`, 1);
}

/** Side effects of a run. `main` wires a real pause and a signal that SIGINT or SIGTERM aborts. */
export type BackupDeps = {
  /** Yields to the event loop before and after the copy, so signal handlers can run. */
  readonly pause?: () => Promise<void>;
  readonly signal?: AbortSignal;
};

/** Checked after each pause: an interrupted run removes its temp directory instead of a copy. */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new BackupError("interrupted; no backup written and the temp directory is removed", 1);
  }
}

/** The copy's name inside the private directory; always used relative to it. */
const COPY = "backup.db";

type DirId = { readonly dev: number; readonly ino: number };

function createPrivateDir(dir: string, target: string): string {
  try {
    return mkdtempSync(join(dir, `.${basename(target)}.tmp-`));
  } catch (err) {
    throw new BackupError(`cannot create temp directory in ${dir}: ${messageOf(err)}`, 1, {
      cause: err,
    });
  }
}

/**
 * mkdtemp creates a new directory with a random name and mode 0700: no other user can create,
 * swap or read a file in it. The run works inside it by relative names, so a rename of the
 * directory itself in a shared parent cannot redirect the copy or the publish.
 */
function enterPrivateDir(temp: string): DirId {
  try {
    process.chdir(temp);
  } catch (err) {
    throw new BackupError(`cannot enter temp directory ${temp}: ${messageOf(err)}`, 1, {
      cause: err,
    });
  }
  const stat = statSync(".");
  // The name can be swapped between mkdtemp and chdir: only work in this run's own directory.
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new BackupError(`temp directory ${temp} was replaced during the backup`, 1);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function isSameDir(path: string, id: DirId): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && stat.dev === id.dev && stat.ino === id.ino;
}

/** Remove the copy and the temp directory; never a directory that this run did not create. */
function leavePrivateDir(home: string, temp: string | undefined, own: DirId | undefined): void {
  try {
    if (own !== undefined) rmSync(COPY, { force: true });
  } catch {
    // Deliberate: a failed cleanup must not hide the outcome; the directory is owner-only.
  }
  try {
    process.chdir(home);
    if (temp !== undefined && own !== undefined && isSameDir(temp, own)) rmdirSync(temp);
  } catch {
    // Deliberate: as above; an empty owner-only directory is all that can stay behind.
  }
}

/** Read-only: never creates, migrates or writes the live file, and accepts any schema version. */
function copyLive(source: string): void {
  let db: Database | undefined;
  try {
    db = new Database(source, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    // Bound, never spliced into SQL. VACUUM copies the live pages only, in rollback-journal mode.
    db.query("VACUUM INTO ?").run(COPY);
  } catch (err) {
    throw new BackupError(`cannot copy ${source}: ${messageOf(err)}`, 1, { cause: err });
  } finally {
    db?.close();
  }
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

/**
 * `link` never replaces an existing target; `rename` is the fallback without hard links.
 * Returns true when the copy was linked, so it is still reachable inside the temp directory.
 */
function publish(target: string): boolean {
  try {
    linkSync(COPY, target);
    return true;
  } catch (err) {
    const code = codeOf(err);
    if (code === "EEXIST") {
      throw new BackupError(`target ${target} exists; choose a new file name`, 2, { cause: err });
    }
    if (typeof code !== "string" || !NO_HARD_LINKS.has(code)) {
      throw new BackupError(`cannot write ${target}: ${messageOf(err)}`, 1, { cause: err });
    }
  }
  assertTargetFree(target);
  try {
    renameSync(COPY, target);
  } catch (err) {
    throw new BackupError(`cannot write ${target}: ${messageOf(err)}`, 1, { cause: err });
  }
  return false;
}

function countRows(db: Database, table: "checks" | "results" | "incidents"): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

/** The numbers of the published file, not of the live one, which may have moved on. */
function report(path: string, target: string): string {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    return `backup ${target}: schema version ${row?.user_version ?? 0}, checks ${countRows(db, "checks")}, results ${countRows(db, "results")}, incidents ${countRows(db, "incidents")}`;
  } catch (err) {
    throw new BackupError(`cannot read ${target}: ${messageOf(err)}`, 1, { cause: err });
  } finally {
    db?.close();
  }
}

const noPause = (): Promise<void> => Promise.resolve();

/**
 * Write a consistent copy of the live data at `PULSE_DB` to the one path in `args` and return the
 * report line. Throws a BackupError; the temp directory that this run created is removed on every
 * error and on an abort of `deps.signal`. Only SIGKILL or a crash can leave it behind.
 */
export async function runBackup(
  args: readonly string[],
  env: Env,
  deps: BackupDeps = {},
): Promise<string> {
  const { pause = noPause, signal } = deps;
  const target = args.length === 1 ? args[0] : undefined;
  if (target === undefined || target === "") throw new BackupError(BACKUP_USAGE, 2);
  // Absolute: the copy and the publish run inside the temp directory.
  const source = resolve(readString(env, "PULSE_DB") ?? "./pulse.db");
  assertTargetFree(target);
  const dir = dirname(target);
  assertIsKind(dir, "directory", "target directory");
  assertIsKind(source, "file", "source (PULSE_DB)");
  assertNotAborted(signal);
  const home = process.cwd();
  // Owner-only: the temp directory, and also a copy that SQLite creates outside of it.
  const umask = process.umask(0o077);
  let temp: string | undefined;
  let own: DirId | undefined;
  try {
    temp = createPrivateDir(dir, target);
    own = enterPrivateDir(temp);
    await pause();
    assertNotAborted(signal);
    copyLive(source);
    // VACUUM is synchronous: a signal during it is handled here, before the publish.
    await pause();
    assertNotAborted(signal);
    const published = resolve(home, target);
    return report(publish(published) ? COPY : published, target);
  } finally {
    process.umask(umask);
    leavePrivateDir(home, temp, own);
  }
}
