import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { nodeAtomicWriteSyncFs } from "@lorenzh/pulse-kit";
import type { ReloadFs } from "./config-reload.ts";
import type { WriteFs } from "./config-write.ts";

/** The real file operations of the reload and the writer. */
export const nodeConfigFs: ReloadFs & WriteFs = {
  stat: (path) => {
    const { mtimeMs, size, ino } = statSync(path);
    return { mtimeMs, size, ino };
  },
  readFile: (path) => readFileSync(path),
  atomic: nodeAtomicWriteSyncFs,
  assertWritable: (dir) => accessSync(dir, constants.W_OK),
};
