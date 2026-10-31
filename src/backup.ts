import { Database } from "bun:sqlite";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
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
type Temp = FileId & { readonly fd: number };

/**
 * Exclusive create: fails with EEXIST on anything already at `temp`, also a dangling symlink, so
 * the copy is never written through a planted link and never replaces a file of someone else.
 */
function createTemp(temp: string): Temp {
  let fd: number;
  try {
    fd = openSync(temp, "wx", 0o600);
  } catch (err) {
    throw new BackupError(`cannot create temp file ${temp}: ${messageOf(err)}`, 1, { cause: err });
  }
  try {
    const stat = fstatSync(fd);
    return { fd, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    closeSync(fd);
    throw new BackupError(`cannot check temp file ${temp}: ${messageOf(err)}`, 1, { cause: err });
  }
}

function isSameFile(path: string, id: FileId): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.dev === id.dev && stat.ino === id.ino;
  } catch (err) {
    if (codeOf(err) === "ENOENT") return false;
    throw new BackupError(`cannot check temp file ${path}: ${messageOf(err)}`, 1, { cause: err });
  }
}

/** The name can be swapped after the create: refuse to publish what this run did not write. */
function assertSameTemp(temp: string, id: FileId): void {
  if (!isSameFile(temp, id)) {
    throw new BackupError(`temp file ${temp} was replaced during the backup`, 1);
  }
}

/** Through the fd of the exclusive create, never by name: a swapped name gets no data. */
function writeImage(temp: string, fd: number, image: Uint8Array): void {
  try {
    let offset = 0;
    while (offset < image.length) {
      offset += writeSync(fd, image, offset, image.length - offset);
    }
    fsyncSync(fd);
  } catch (err) {
    throw new BackupError(`cannot write temp file ${temp}: ${messageOf(err)}`, 1, { cause: err });
  }
}

/** A consistent image of the database and its numbers, read in one read transaction. */
export type Snapshot = {
  readonly image: Uint8Array;
  readonly version: number;
  readonly checks: number;
  readonly results: number;
  readonly incidents: number;
};

function countRows(db: Database, table: "checks" | "results" | "incidents"): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

/** Header bytes 18 and 19: 2 marks a WAL file, 1 a rollback-journal file (the SQLite file format). */
function toRollbackJournal(image: Uint8Array): void {
  if (image.length >= 20 && image[18] === 2 && image[19] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
}

/** Read-only: never creates, migrates or writes the live file, and accepts any schema version. */
function readSnapshot(source: string): Snapshot {
  let db: Database | undefined;
  try {
    db = new Database(source, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");
    // One read transaction: the numbers and the image come from the same snapshot.
    db.run("BEGIN");
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    const counts = {
      version: row?.user_version ?? 0,
      checks: countRows(db, "checks"),
      results: countRows(db, "results"),
      incidents: countRows(db, "incidents"),
    };
    // The image is held in memory, so the command needs memory for one copy of the file.
    const image = db.serialize();
    // Like a VACUUM INTO copy, the backup has no WAL; the API switches it to WAL on open.
    toRollbackJournal(image);
    return { image, ...counts };
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

/** Remove the temp name only while it is still this run's file. */
function removeOwnTemp(temp: string, id: FileId): void {
  try {
    if (isSameFile(temp, id)) rmSync(temp, { force: true });
  } catch {
    // Deliberate: a failed cleanup must not hide the outcome; the file is owner-only and emptied.
  }
}

/** On failure the inode may sit under a name that someone else chose: leave it empty. */
function closeTemp(temp: Temp, isPublished: boolean): void {
  try {
    if (!isPublished) ftruncateSync(temp.fd, 0);
  } finally {
    closeSync(temp.fd);
  }
}

/**
 * Write a consistent copy of the database at `PULSE_DB` to the one path in `args` and return the
 * report line. Throws a BackupError; the temp file that this run created is removed on every path.
 */
export function runBackup(
  args: readonly string[],
  env: Env,
  pid: number,
  read: (source: string) => Snapshot = readSnapshot,
): string {
  const target = args.length === 1 ? args[0] : undefined;
  if (target === undefined || target === "") throw new BackupError(BACKUP_USAGE, 2);
  const source = readString(env, "PULSE_DB") ?? "./pulse.db";
  assertTargetFree(target);
  const dir = dirname(target);
  assertIsKind(dir, "directory", "target directory");
  assertIsKind(source, "file", "source (PULSE_DB)");
  const tempPath = join(dir, `.${basename(target)}.tmp-${pid}`);
  // Outside the try: a file that this run did not create is never removed.
  const temp = createTemp(tempPath);
  let isPublished = false;
  try {
    const snapshot = read(source);
    writeImage(tempPath, temp.fd, snapshot.image);
    assertSameTemp(tempPath, temp);
    publish(tempPath, target);
    isPublished = true;
    return `backup ${target}: schema version ${snapshot.version}, checks ${snapshot.checks}, results ${snapshot.results}, incidents ${snapshot.incidents}`;
  } finally {
    closeTemp(temp, isPublished);
    removeOwnTemp(tempPath, temp);
  }
}
