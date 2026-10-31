import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupError, runBackup, type Snapshot } from "./backup.ts";
import { openDb } from "./db.ts";

// The temp name holds the pid, so another user of a shared directory can guess it and plant a file.
const PID = 4242;

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

test("backup refuses a dangling symlink at the temp name and writes nothing through it", async () => {
  const shared = join(dir, "shared");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(shared);
  mkdirSync(elsewhere);
  const stolen = join(elsewhere, "stolen.db");
  const planted = join(shared, `.b.db.tmp-${PID}`);
  symlinkSync(stolen, planted);
  const target = join(shared, "b.db");

  let err: BackupError | undefined;
  let line = "";
  try {
    line = await runBackup([target], { PULSE_DB: source }, PID);
  } catch (caught) {
    if (!(caught instanceof BackupError)) throw caught;
    err = caught;
  }
  assert.equal(line, "");
  assert.equal(existsSync(stolen), false);
  assert.throws(() => lstatSync(target), { code: "ENOENT" });
  assert.equal(readlinkSync(planted), stolen);
  assert.equal(err?.exitCode, 1);
  assert.match(err?.message ?? "", /^cannot create temp file .*\.b\.db\.tmp-4242: /);
});

test("backup keeps a file that already sits at the temp name", async () => {
  const planted = join(dir, `.c.db.tmp-${PID}`);
  writeFileSync(planted, "not mine");
  const target = join(dir, "c.db");

  const err = await backupError(() => runBackup([target], { PULSE_DB: source }, PID));
  assert.equal(existsSync(planted), true);
  assert.equal(readFileSync(planted, "utf8"), "not mine");
  assert.equal(existsSync(target), false);
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /^cannot create temp file /);
});

test("backup publishes a regular owner-only file and removes the temp file it created", async () => {
  const target = join(dir, "d.db");

  const line = await runBackup([target], { PULSE_DB: source }, PID);
  assert.match(line, /^backup .*d\.db: schema version \d+, checks 0, results 0, incidents 0$/);
  const stat = lstatSync(target);
  assert.equal(stat.isFile(), true);
  // The temp file is created owner-only, and the published copy keeps that mode.
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
  );
});

const MARKER = "SECRET-MARKER-123";

/** A reader that swaps the temp name after the create, as another user of the directory could. */
function swappingRead(
  temp: string,
  moved: string,
  plant: () => void,
): (source: string) => Snapshot {
  return () => {
    renameSync(temp, moved);
    plant();
    const image = new TextEncoder().encode(MARKER);
    return { image, version: 2, checks: 1, results: 0, incidents: 0 };
  };
}

test("backup writes no data into a file swapped in at the temp name and keeps that file", async () => {
  const shared = join(dir, "shared");
  mkdirSync(shared);
  const loot = join(dir, "loot.db");
  writeFileSync(loot, "", { mode: 0o666 });
  const temp = join(shared, `.e.db.tmp-${PID}`);
  const moved = join(shared, ".moved");
  const target = join(shared, "e.db");

  const read = swappingRead(temp, moved, () => linkSync(loot, temp));
  const err = await backupError(() => runBackup([target], { PULSE_DB: source }, PID, { read }));
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /^temp file .*\.e\.db\.tmp-4242 was replaced during the backup$/);
  assert.equal(readFileSync(loot, "utf8"), "");
  assert.equal(lstatSync(temp).ino, lstatSync(loot).ino);
  // The file that this run wrote may sit under a name it does not own: it is left empty.
  assert.equal(readFileSync(moved, "utf8"), "");
  assert.equal(existsSync(target), false);
});

test("backup writes nothing outside the target directory through a symlink swapped in", async () => {
  const shared = join(dir, "shared");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(shared);
  mkdirSync(elsewhere);
  const out = join(elsewhere, "out.db");
  const temp = join(shared, `.f.db.tmp-${PID}`);
  const target = join(shared, "f.db");

  const read = swappingRead(temp, join(shared, ".moved"), () => symlinkSync(out, temp));
  const err = await backupError(() => runBackup([target], { PULSE_DB: source }, PID, { read }));
  assert.equal(err.exitCode, 1);
  assert.equal(existsSync(out), false);
  assert.equal(readlinkSync(temp), out);
  assert.throws(() => lstatSync(target), { code: "ENOENT" });
});

const MIB = 1024 * 1024;

/** A snapshot of 9 MiB, so the copy takes three writes of at most 4 MiB. */
function bigRead(): Snapshot {
  return {
    image: new Uint8Array(9 * MIB).fill(7),
    version: 2,
    checks: 1,
    results: 0,
    incidents: 0,
  };
}

function tempFiles(): string[] {
  return readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

test("backup stopped by a signal during the copy removes its temp file and publishes nothing", async () => {
  const target = join(dir, "g.db");
  const controller = new AbortController();
  let pauses = 0;
  const sizes: number[] = [];
  // A fake pause: the signal arrives after the first write, like a Ctrl+C during a long copy.
  const pause = (): Promise<void> => {
    pauses += 1;
    sizes.push(lstatSync(join(dir, `.g.db.tmp-${PID}`)).size);
    if (pauses === 2) controller.abort();
    return Promise.resolve();
  };

  const err = await backupError(() =>
    runBackup([target], { PULSE_DB: source }, PID, {
      read: bigRead,
      pause,
      signal: controller.signal,
    }),
  );
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /^interrupted; no backup written and the temp file is removed$/);
  assert.deepEqual(sizes, [0, 4 * MIB]);
  assert.deepEqual(tempFiles(), []);
  assert.equal(existsSync(target), false);
});

test("backup stopped by a signal during the read writes no byte", async () => {
  const target = join(dir, "h.db");
  const controller = new AbortController();
  const read = (): Snapshot => {
    controller.abort();
    return bigRead();
  };
  const sizes: number[] = [];
  const pause = (): Promise<void> => {
    sizes.push(lstatSync(join(dir, `.h.db.tmp-${PID}`)).size);
    return Promise.resolve();
  };

  const err = await backupError(() =>
    runBackup([target], { PULSE_DB: source }, PID, { read, pause, signal: controller.signal }),
  );
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /^interrupted; /);
  assert.deepEqual(sizes, [0]);
  assert.deepEqual(tempFiles(), []);
  assert.equal(existsSync(target), false);
});

test("backup that is not stopped writes a large copy in chunks and publishes it", async () => {
  const target = join(dir, "i.db");
  let pauses = 0;
  const pause = (): Promise<void> => {
    pauses += 1;
    return Promise.resolve();
  };

  const line = await runBackup([target], { PULSE_DB: source }, PID, {
    read: bigRead,
    pause,
    signal: new AbortController().signal,
  });
  assert.match(line, /^backup .*i\.db: schema version 2, checks 1, results 0, incidents 0$/);
  // One pause after the read and one after each of the three writes.
  assert.equal(pauses, 4);
  assert.equal(lstatSync(target).size, 9 * MIB);
  assert.deepEqual(tempFiles(), []);
});
