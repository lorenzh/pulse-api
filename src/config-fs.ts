import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { ReloadFs } from "./config-reload.ts";
import type { WriteFs } from "./config-write.ts";

function codeOf(err: unknown): string | undefined {
  const code = err instanceof Error ? Reflect.get(err, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

function fillTemp(fd: number, data: Buffer, like: string): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  let existing: { mode: number; uid: number; gid: number } | undefined;
  try {
    existing = statSync(like);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
  if (existing !== undefined) {
    fchmodSync(fd, existing.mode & 0o7777);
    const own = fstatSync(fd);
    if (own.uid !== existing.uid || own.gid !== existing.gid) {
      try {
        fchownSync(fd, existing.uid, existing.gid);
      } catch (err) {
        // Only a privileged process may change the owner; keep the file with ours.
        if (codeOf(err) !== "EPERM") throw err;
      }
    }
  }
  fsyncSync(fd);
}

/** Exclusive create, data, mode and owner of `like`, fsync. Removes the file on a later failure. */
function writeTemp(temp: string, data: Buffer, like: string): void {
  // A failed exclusive create removes nothing: the name may belong to another writer.
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      fillTemp(fd, data, like);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort: the original error is reported.
    }
    throw err;
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The real file operations of the reload and the writer. */
export const nodeConfigFs: ReloadFs & WriteFs = {
  stat: (path) => {
    const { mtimeMs, size, ino } = statSync(path);
    return { mtimeMs, size, ino };
  },
  readFile: (path) => readFileSync(path),
  writeTemp,
  fsyncDir,
  rename: (from, to) => renameSync(from, to),
  remove: (path) => unlinkSync(path),
  lstat: (path) => {
    lstatSync(path);
  },
  assertWritable: (dir) => accessSync(dir, constants.W_OK),
};
