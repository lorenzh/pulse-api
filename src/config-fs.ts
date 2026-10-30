import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { ReloadFs } from "./config-reload.ts";
import type { WriteFs } from "./config-write.ts";

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset);
}

/** The real file operations of the reload and the writer. */
export const nodeConfigFs: ReloadFs & WriteFs = {
  stat: (path) => {
    const { mtimeMs, size, ino } = statSync(path);
    return { mtimeMs, size, ino };
  },
  readFile: (path) => readFileSync(path),
  writeTemp(path, data, like) {
    const original = statSync(like);
    const fd = openSync(path, "wx", original.mode & 0o7777);
    try {
      writeAll(fd, data);
      // The umask may have cut the mode at creation.
      fchmodSync(fd, original.mode & 0o7777);
      const own = fstatSync(fd);
      if (own.uid !== original.uid || own.gid !== original.gid) {
        try {
          fchownSync(fd, original.uid, original.gid);
        } catch (err) {
          // Without privilege a file cannot be given to another owner: it stays ours.
          if (!(err instanceof Error) || Reflect.get(err, "code") !== "EPERM") throw err;
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  fsyncDir(dir) {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  remove: unlinkSync,
  assertWritable: (dir) => accessSync(dir, constants.W_OK),
};
