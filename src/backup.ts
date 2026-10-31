import { Database } from "bun:sqlite";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

type FileId = { readonly dev: number; readonly ino: number };

/**
 * Exclusive create: fails with EEXIST on anything already at `temp`, also a dangling symlink, so
 * the copy is never written through a planted link and never replaces a file of someone else.
 */
function createTemp(temp: string): FileId {
  let fd: number;
  try {
    fd = openSync(temp, "wx", 0o600);
  } catch (err) {
    throw new BackupError(`cannot create temp file ${temp}: ${messageOf(err)}`, 1, { cause: err });
  }
  try {
    const stat = fstatSync(fd);
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

/** SQLite opens `temp` by name again: refuse to publish if it was swapped in between. */
function assertSameTemp(temp: string, id: FileId): void {
  let isSame = false;
  try {
    const stat = lstatSync(temp);
    isSame = stat.isFile() && stat.dev === id.dev && stat.ino === id.ino;
  } catch (err) {
    throw new BackupError(`cannot check temp file ${temp}: ${messageOf(err)}`, 1, { cause: err });
  }
  if (!isSame) throw new BackupError(`temp file ${temp} was replaced during the backup`, 1);
}

/** Read-only: never creates, migrates or writes the live file, and accepts any schema version. */
function copySnapshot(source: string, temp: string): void {
  let db: Database | undefined;
  try {
    db = new Database(source, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    // Bound parameter: a target path with a quote cannot change the SQL.
    db.run("VACUUM INTO ?", [temp]);
  } catch (err) {
    throw new BackupError(`cannot copy ${source}: ${messageOf(err)}`, 1, { cause: err });
  } finally {
    db?.close();
  }
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

/** `link` never replaces an existing target; `rename` is the fallback without hard links. */
function publish(temp: string, target: string): void {
  try {
    linkSync(temp, target);
    return;
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
    renameSync(temp, target);
  } catch (err) {
    throw new BackupError(`cannot write ${target}: ${messageOf(err)}`, 1, { cause: err });
  }
}

function countRows(db: Database, table: "checks" | "results" | "incidents"): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

/** The numbers of the snapshot itself: the source may have moved on since. */
function describe(target: string): string {
  let db: Database | undefined;
  try {
    db = new Database(target, { readonly: true });
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    const version = row?.user_version ?? 0;
    return `backup ${target}: schema version ${version}, checks ${countRows(db, "checks")}, results ${countRows(db, "results")}, incidents ${countRows(db, "incidents")}`;
  } catch (err) {
    throw new BackupError(`cannot read backup ${target}: ${messageOf(err)}`, 1, { cause: err });
  } finally {
    db?.close();
  }
}

/**
 * Write a consistent copy of the database at `PULSE_DB` to the one path in `args` and return the
 * report line. Throws a BackupError; the temp file that this run created is removed on every path.
 */
export function runBackup(args: readonly string[], env: Env, pid: number): string {
  const target = args.length === 1 ? args[0] : undefined;
  if (target === undefined || target === "") throw new BackupError(BACKUP_USAGE, 2);
  const source = readString(env, "PULSE_DB") ?? "./pulse.db";
  assertTargetFree(target);
  const dir = dirname(target);
  assertIsKind(dir, "directory", "target directory");
  assertIsKind(source, "file", "source (PULSE_DB)");
  const temp = join(dir, `.${basename(target)}.tmp-${pid}`);
  // Outside the try: a file that this run did not create is never removed.
  const tempId = createTemp(temp);
  try {
    // VACUUM INTO accepts an existing file when it is empty.
    copySnapshot(source, temp);
    assertSameTemp(temp, tempId);
    publish(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return describe(target);
}
