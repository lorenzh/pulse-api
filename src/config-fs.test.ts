import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@lorenzh/pulse-contract";
import { type AtomicWriteSyncFs, nodeAtomicWriteSyncFs } from "@lorenzh/pulse-kit";
import type { AuditRecord, PendingAudit, PendingEntry } from "./audit-log.ts";
import { parseConfig } from "./config.ts";
import { nodeConfigFs } from "./config-fs.ts";
import { createConfigHolder } from "./config-holder.ts";
import { adminRevision, revisionOf } from "./config-reload.ts";
import { ConfigWriteError, createConfigWriter } from "./config-write.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-config-fs-"));
  file = join(dir, "checks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FILE_A = `${JSON.stringify({ checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }] }, null, 2)}\n`;
const FILE_B = `${JSON.stringify({ checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }], components: [{ id: "b", name: "B", checkIds: ["a"] }] }, null, 2)}\n`;

const errno = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });

const codeOf = (fn: () => void): unknown => {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? Reflect.get(err, "code") : undefined;
  }
  return undefined;
};

class MemPending implements PendingAudit {
  rows: PendingEntry[] = [];
  private next = 1;
  insert(entry: AuditRecord & { revision: string }, tempPath: string): number {
    const pendingId = this.next++;
    this.rows.push({ pendingId, entry, tempPath });
    return pendingId;
  }
  deleteByTemp(tempPath: string): void {
    this.rows = this.rows.filter((r) => r.tempPath !== tempPath);
  }
  promote(pendingId: number): AuditEntry {
    const row = this.rows.find((r) => r.pendingId === pendingId);
    if (row === undefined) throw new Error("no row");
    this.rows = this.rows.filter((r) => r !== row);
    return { id: pendingId, ...row.entry };
  }
  list(): PendingEntry[] {
    return [...this.rows];
  }
}

type Fail = Partial<Record<"fsync" | "fchmod" | "close", string>>;

/**
 * The real kit operations, logged. `fail` throws on the temp fd only (the fd of the "wx" open);
 * a failing close really closes first. `fake` replaces whole operations.
 */
function recorder(fail: Fail = {}, fake: Partial<AtomicWriteSyncFs> = {}) {
  const log: string[] = [];
  let tempFd: number | undefined;
  let tempMode: number | undefined;
  const real = nodeAtomicWriteSyncFs;
  const onTemp = (fd: number, op: keyof Fail): void => {
    const code = fail[op];
    if (fd === tempFd && code !== undefined) throw errno(code);
  };
  const atomic: AtomicWriteSyncFs = {
    stat: (p) => {
      log.push("stat");
      return real.stat(p);
    },
    open: (p, flags, mode) => {
      const fd = real.open(p, flags, mode);
      if (flags === "wx") {
        tempFd = fd;
        tempMode = fstatSync(fd).mode & 0o777;
        log.push(`open wx ${mode?.toString(8)}`);
      } else log.push(`open ${flags}`);
      return fd;
    },
    write: (fd, data, offset) => {
      if (log.at(-1) !== "write") log.push("write");
      return real.write(fd, data, offset);
    },
    fchmod: (fd, mode) => {
      log.push(`fchmod ${mode.toString(8)}`);
      onTemp(fd, "fchmod");
      real.fchmod(fd, mode);
    },
    fstat: (fd) => {
      log.push("fstat");
      return real.fstat(fd);
    },
    fchown: (fd, uid, gid) => {
      log.push(`fchown ${uid} ${gid}`);
      real.fchown(fd, uid, gid);
    },
    fsync: (fd) => {
      log.push("fsync");
      onTemp(fd, "fsync");
      real.fsync(fd);
    },
    close: (fd) => {
      log.push("close");
      real.close(fd);
      onTemp(fd, "close");
    },
    rename: (from, to) => {
      log.push("rename");
      real.rename(from, to);
    },
    unlink: (p) => {
      log.push("unlink");
      real.unlink(p);
    },
    ...fake,
  };
  return { atomic, log, tempMode: () => tempMode };
}

/** One component create through the writer; "ok" or the error code and message. */
async function createB(atomic: AtomicWriteSyncFs, pending = new MemPending()): Promise<string> {
  const writer = createConfigWriter({
    path: file,
    fs: { ...nodeConfigFs, atomic },
    holder: createConfigHolder(parseConfig(JSON.parse(FILE_A))),
    reloader: {
      revision: () => revisionOf(readFileSync(file)),
      adopt: () => undefined,
      fileStatus: () => ({ state: "ok", message: null, lastAppliedAt: 0 }),
    },
    generation: () => 0,
    tempSuffix: () => "t1",
    hasOpenIncidentFor: () => false,
    pending,
    now: () => 1000,
    warn: () => undefined,
  });
  const ifMatch = adminRevision(revisionOf(readFileSync(file)), 0);
  try {
    await writer.apply(
      { kind: "component", action: "create", body: { id: "b", name: "B", checkIds: ["a"] } },
      ifMatch,
      { tokenId: "tok_1", name: "ops" },
    );
    return "ok";
  } catch (err) {
    if (!(err instanceof ConfigWriteError)) throw err;
    return `${err.code}: ${err.message}`;
  }
}

const temps = (): string[] => readdirSync(dir).filter((n) => n.endsWith(".tmp"));

test("R1: a write runs the kit sequence with a 0600 temp and keeps the 0640 mode", async () => {
  writeFileSync(file, FILE_A);
  chmodSync(file, 0o640);
  const r = recorder();
  expect(await createB(r.atomic)).toBe("ok");
  expect(r.log).toEqual([
    "stat",
    "open wx 600",
    "write",
    "fchmod 640",
    "fstat",
    "fsync",
    "close",
    "open r",
    "fsync",
    "close",
    "rename",
    "open r",
    "fsync",
    "close",
  ]);
  expect(r.tempMode()).toBe(0o600);
  expect(statSync(file).mode & 0o777).toBe(0o640);
  expect(readFileSync(file, "utf8")).toBe(FILE_B);
  expect(temps()).toEqual([]);
});

test("R2: the config fs is the kit fs and no local writer is left", () => {
  expect(nodeConfigFs.atomic).toBe(nodeAtomicWriteSyncFs);
  expect(Object.keys(nodeConfigFs).sort((x, y) => x.localeCompare(y))).toEqual([
    "assertWritable",
    "atomic",
    "lstat",
    "readFile",
    "stat",
  ]);
  const source = (name: string): string =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  for (const name of ["config-fs.ts", "config-write.ts"]) {
    const text = source(name);
    expect(text).not.toMatch(
      /\b(writeSync|fchmodSync|fchownSync|fsyncSync|openSync|unlinkSync|renameSync)\b/,
    );
    expect(text).not.toMatch(/\.(write|fchmod|fchown|fstat)\(/);
  }
  expect(source("config-write.ts")).toMatch(/\bwriteFileAtomicSync\(/);
  // backup.ts keeps renameSync for its own publication rename.
  const offenders = readdirSync(new URL(".", import.meta.url))
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .filter((n) =>
      /\b(writeSync|fchmodSync|fchownSync|fsyncSync|openSync|unlinkSync)\b/.test(source(n)),
    );
  expect(offenders).toEqual([]);
});

test("control 1: a foreign file or a symlink at the temp name is kept and the write fails", async () => {
  writeFileSync(file, FILE_A);
  const temp = `${file}.t1.tmp`;
  writeFileSync(temp, "foreign");
  const pending = new MemPending();
  expect(await createB(recorder().atomic, pending)).toBe(
    "error: checks file could not be written (EEXIST)",
  );
  expect(readFileSync(temp, "utf8")).toBe("foreign");
  expect(readFileSync(file, "utf8")).toBe(FILE_A);
  expect(pending.rows).toEqual([]);

  rmSync(temp);
  const target = join(dir, "target");
  writeFileSync(target, "target bytes");
  symlinkSync(target, temp);
  expect(await createB(recorder().atomic, pending)).toBe(
    "error: checks file could not be written (EEXIST)",
  );
  expect(readFileSync(target, "utf8")).toBe("target bytes");
  expect(readFileSync(file, "utf8")).toBe(FILE_A);
  expect(pending.rows).toEqual([]);
});

test("control 2: a failing fchmod after the create removes the temp file", async () => {
  writeFileSync(file, FILE_A);
  const pending = new MemPending();
  expect(await createB(recorder({ fchmod: "EIO" }).atomic, pending)).toBe(
    "error: checks file could not be written (EIO)",
  );
  expect(temps()).toEqual([]);
  expect(pending.rows).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(FILE_A);
});

test("control 3: a stat ENOTDIR before the create opens nothing", async () => {
  writeFileSync(file, FILE_A);
  const r = recorder(
    {},
    {
      stat: () => {
        throw errno("ENOTDIR");
      },
    },
  );
  expect(await createB(r.atomic)).toBe("error: checks file could not be written (ENOTDIR)");
  expect(r.log.filter((l) => l.startsWith("open"))).toEqual([]);
  expect(temps()).toEqual([]);
});

test("control 4: the owner is copied; EPERM is tolerated and EINVAL fails", async () => {
  writeFileSync(file, FILE_A);
  const { uid, gid } = statSync(file);
  const owned = (code: string) => {
    const calls: number[][] = [];
    const r = recorder(
      {},
      {
        fstat: () => ({ uid: uid + 1, gid }),
        fchown: (_fd, u, g) => {
          calls.push([u, g]);
          throw errno(code);
        },
      },
    );
    return { atomic: r.atomic, calls };
  };
  const eperm = owned("EPERM");
  expect(await createB(eperm.atomic)).toBe("ok");
  expect(eperm.calls).toEqual([[uid, gid]]);
  expect(readFileSync(file, "utf8")).toBe(FILE_B);

  writeFileSync(file, FILE_A);
  const einval = owned("EINVAL");
  expect(await createB(einval.atomic)).toBe("error: checks file could not be written (EINVAL)");
  expect(einval.calls).toEqual([[uid, gid]]);
  expect(temps()).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(FILE_A);
});

test("control 5: lstat throws ENOENT for a missing path and returns for a present one", () => {
  writeFileSync(file, FILE_A);
  expect(codeOf(() => nodeConfigFs.lstat(file))).toBeUndefined();
  expect(codeOf(() => nodeConfigFs.lstat(join(dir, "missing")))).toBe("ENOENT");
});

const PRECEDENCE: { name: string; fail: Fail; expected: string }[] = [
  {
    name: "R3 (a): fsync ENOSPC then close EIO reports the close",
    fail: { fsync: "ENOSPC", close: "EIO" },
    expected: "error: checks file could not be written (EIO)",
  },
  {
    name: "R3 (b): fchmod EIO then close EROFS reports read-only",
    fail: { fchmod: "EIO", close: "EROFS" },
    expected: "readonly: checks file is read-only (EROFS)",
  },
  {
    name: "R3 (c): fsync ENOSPC with a working close reports the fsync",
    fail: { fsync: "ENOSPC" },
    expected: "error: checks file could not be written (ENOSPC)",
  },
  {
    name: "R3 (d): a failing close alone reports the close",
    fail: { close: "EIO" },
    expected: "error: checks file could not be written (EIO)",
  },
];

for (const c of PRECEDENCE) {
  test(c.name, async () => {
    writeFileSync(file, FILE_A);
    const pending = new MemPending();
    const outcome = await createB(recorder(c.fail).atomic, pending);
    expect(outcome).toBe(c.expected);
    expect(outcome).not.toContain("atomic write failed");
    expect(readFileSync(file, "utf8")).toBe(FILE_A);
    expect(temps()).toEqual([]);
    expect(pending.rows).toEqual([]);
  });
}

// The recorder's close really closes before it throws; this proves the fd is gone.
test("R3: a failing temp close does not leak the fd", async () => {
  writeFileSync(file, FILE_A);
  let fd = -1;
  const r = recorder({ close: "EIO" });
  const open = r.atomic.open;
  r.atomic.open = (p, flags, mode) => {
    const got = open(p, flags, mode);
    if (flags === "wx") fd = got;
    return got;
  };
  await createB(r.atomic);
  expect(codeOf(() => closeSync(fd))).toBe("EBADF");
});
