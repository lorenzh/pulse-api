import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupError, runBackup } from "./backup.ts";
import { openDb } from "./db.ts";

let dir = "";
let source = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-backup-temp-"));
  source = join(dir, "pulse.db");
  openDb(source).close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function backupError(run: () => Promise<unknown>): Promise<BackupError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BackupError) return err;
    throw err;
  }
  throw new Error("expected a BackupError");
}

const tempEntries = (path: string): string[] =>
  readdirSync(path).filter((f) => f.includes(".tmp-"));

test("backup publishes a regular owner-only file and removes the temp directory it created", async () => {
  const target = join(dir, "d.db");

  const line = await runBackup([target], { PULSE_DB: source });
  assert.match(line, /^backup .*d\.db: schema version \d+, checks 0, results 0, incidents 0$/);
  const stat = lstatSync(target);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(tempEntries(dir), []);
});

/**
 * Another user of a shared directory moves the temp directory away during the run and puts a
 * symlink to a directory of their own at its name, as the earlier temp-file swap attack did.
 */
async function swapTempDir(plant: (loot: string) => void): Promise<{ line: string; loot: string }> {
  const shared = join(dir, "shared");
  const loot = join(dir, "loot");
  mkdirSync(shared);
  mkdirSync(loot);
  plant(loot);
  let swapped = false;
  // At the first pause the run sits in its temp directory, and the copy is not written yet.
  const pause = (): Promise<void> => {
    if (!swapped) {
      const temp = process.cwd();
      renameSync(temp, join(shared, ".moved"));
      symlinkSync(loot, temp);
      swapped = true;
    }
    return Promise.resolve();
  };
  const line = await runBackup([join(shared, "e.db")], { PULSE_DB: source }, { pause });
  return { line, loot };
}

test("backup writes no data into a file planted behind a swapped temp directory", async () => {
  const { line, loot } = await swapTempDir((path) =>
    writeFileSync(join(path, "backup.db"), "", { mode: 0o666 }),
  );
  assert.equal(readFileSync(join(loot, "backup.db"), "utf8"), "");
  // The copy went into this run's own directory and was published from there.
  assert.match(line, /^backup .*e\.db: schema version \d+, checks 0, results 0, incidents 0$/);
  const target = join(dir, "shared", "e.db");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(readFileSync(target).subarray(0, 15).toString(), "SQLite format 3");
  // The attacker's symlink is not removed, nor followed.
  const [link] = tempEntries(join(dir, "shared"));
  assert.equal(readlinkSync(join(dir, "shared", link ?? "")), loot);
});

test("backup creates no file through a swapped temp directory", async () => {
  const { loot } = await swapTempDir(() => undefined);
  assert.deepEqual(readdirSync(loot), []);
  assert.equal(existsSync(join(dir, "shared", "e.db")), true);
});

/** A pause that aborts on call `stopAt`, and records the temp directory's files at each call. */
function stoppingPause(stopAt: number): {
  pause: () => Promise<void>;
  signal: AbortSignal;
  seen: string[][];
} {
  const controller = new AbortController();
  const seen: string[][] = [];
  const pause = (): Promise<void> => {
    seen.push(readdirSync(".").map((f) => `${f}:${statSync(f).size > 0}`));
    if (seen.length === stopAt) controller.abort();
    return Promise.resolve();
  };
  return { pause, signal: controller.signal, seen };
}

test("backup stopped by a signal before the copy writes nothing and removes its temp directory", async () => {
  const target = join(dir, "g.db");
  const { pause, signal, seen } = stoppingPause(1);

  const err = await backupError(() => runBackup([target], { PULSE_DB: source }, { pause, signal }));
  assert.equal(err.exitCode, 1);
  assert.equal(err.message, "interrupted; no backup written and the temp directory is removed");
  assert.deepEqual(seen, [[]]);
  assert.deepEqual(tempEntries(dir), []);
  assert.equal(existsSync(target), false);
});

test("backup stopped by a signal during the copy removes the copy and publishes nothing", async () => {
  const target = join(dir, "h.db");
  const { pause, signal, seen } = stoppingPause(2);

  const err = await backupError(() => runBackup([target], { PULSE_DB: source }, { pause, signal }));
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /^interrupted; /);
  // The full copy existed when the signal was handled, and the run removed it.
  assert.deepEqual(seen, [[], ["backup.db:true"]]);
  assert.deepEqual(tempEntries(dir), []);
  assert.equal(existsSync(target), false);
  assert.equal(process.cwd() === dir, false);
});

test("backup that is not stopped pauses before and after the copy and publishes it", async () => {
  const target = join(dir, "i.db");
  const { pause, signal, seen } = stoppingPause(0);

  const line = await runBackup([target], { PULSE_DB: source }, { pause, signal });
  assert.match(line, /^backup .*i\.db: schema version \d+, checks 0, results 0, incidents 0$/);
  assert.equal(seen.length, 2);
  assert.deepEqual(tempEntries(dir), []);
});
