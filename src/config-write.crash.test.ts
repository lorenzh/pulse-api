import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AuditEntry } from "@lorenzh/pulse-contract";
import type { AuditRecord, PendingAudit, PendingEntry } from "./audit-log.ts";
import { parseConfig } from "./config.ts";
import { createConfigHolder } from "./config-holder.ts";
import { type ConfigWriter, createConfigWriter, type WriteFs } from "./config-write.ts";

// The crash model of the spec's "Power loss" counterexamples: every crash point, every subset of
// the un-synced directory changes, every kept prefix k of the un-synced SQLite commits.

const PATH = "/d/checks.json";
const check = (id: string) => ({
  id,
  name: id.toUpperCase(),
  url: `https://${id}.example/`,
  intervalMs: 60000,
});
const FILE_A = `${JSON.stringify({ checks: [check("a")] }, null, 2)}\n`;
const FILE_B = `${JSON.stringify({ checks: [check("a"), check("b")] }, null, 2)}\n`;
const sha = (s: string): string => `sha256-${createHash("sha256").update(s).digest("hex")}`;
const REV_A = sha(FILE_A);
const REV_B = sha(FILE_B);
const ACTOR = { tokenId: "tok_1", name: "ops" };

class PowerLoss extends Error {
  override name = "PowerLoss";
}

const errno = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });

type Change =
  | { op: "create"; name: string; data: Buffer }
  | { op: "rename"; from: string; to: string }
  | { op: "unlink"; name: string };

/** One directory with a live view, a durable view and the un-synced changes in call order. */
class CrashFs implements WriteFs {
  live = new Map<string, Buffer>([[PATH, Buffer.from(FILE_A)]]);
  durable = new Map(this.live);
  changes: Change[] = [];
  /** 1-based numbers of the fsyncDir calls that throw EIO without syncing. */
  failingSyncs = new Set<number>();
  syncs = 0;
  renameMode: "ok" | "throw" | "move-throw" = "ok";

  readFile(path: string): Buffer {
    const bytes = this.live.get(path);
    if (bytes === undefined) throw errno("ENOENT");
    return bytes;
  }
  writeTemp(temp: string, data: Buffer): void {
    if (this.live.has(temp)) throw errno("EEXIST");
    this.live.set(temp, data);
    this.changes.push({ op: "create", name: temp, data });
  }
  fsyncDir(): void {
    this.syncs += 1;
    if (this.failingSyncs.has(this.syncs)) throw errno("EIO");
    this.durable = new Map(this.live);
    this.changes = [];
  }
  rename(from: string, to: string): void {
    if (this.renameMode === "throw") {
      this.renameMode = "ok";
      throw errno("EIO");
    }
    const bytes = this.live.get(from);
    if (bytes === undefined) throw errno("ENOENT");
    this.live.delete(from);
    this.live.set(to, bytes);
    this.changes.push({ op: "rename", from, to });
    if (this.renameMode === "move-throw") {
      this.renameMode = "ok";
      throw errno("EIO");
    }
  }
  remove(path: string): void {
    if (!this.live.delete(path)) throw errno("ENOENT");
    this.changes.push({ op: "unlink", name: path });
  }
  lstat(path: string): void {
    if (!this.live.has(path)) throw errno("ENOENT");
  }
  assertWritable(): void {}

  /** Apply the chosen un-synced changes to the durable view; the result is the new disk. */
  powerLoss(chosen: (index: number) => boolean): void {
    const disk = new Map(this.durable);
    this.changes.forEach((c, i) => {
      if (!chosen(i)) return;
      if (c.op === "create") disk.set(c.name, c.data);
      if (c.op === "unlink") disk.delete(c.name);
      if (c.op === "rename") {
        const bytes = disk.get(c.from);
        if (bytes === undefined) return;
        disk.delete(c.from);
        disk.set(c.to, bytes);
      }
    });
    this.live = disk;
    this.durable = new Map(disk);
    this.changes = [];
    this.syncs = 0;
    this.failingSyncs.clear();
  }
  file(): "A" | "B" | "other" {
    const text = this.live.get(PATH)?.toString();
    if (text === FILE_A) return "A";
    return text === FILE_B ? "B" : "other";
  }
}

type Journal = "wal" | "delete";
type Op =
  | { kind: "insert"; pendingId: number; entry: AuditRecord & { revision: string }; temp: string }
  | { kind: "delete"; temp: string }
  | { kind: "promote"; pendingId: number };

/** SQLite as a log of commits; only a durable commit makes itself and all before it durable. */
class CrashPendingAudit implements PendingAudit {
  private log: Op[] = [];
  private durableCount = 0;
  private nextId = 1;

  private readonly journal: Journal;
  private readonly durableLevel: number;

  constructor(journal: Journal, durableLevel: number) {
    this.journal = journal;
    this.durableLevel = durableLevel;
  }

  private commit(op: Op, level: number): void {
    this.log.push(op);
    if (level >= (this.journal === "wal" ? 2 : 3)) this.durableCount = this.log.length;
  }
  private connectionLevel(): number {
    return this.journal === "wal" ? 1 : 2;
  }
  state(): { rows: PendingEntry[]; entries: AuditEntry[] } {
    let rows: PendingEntry[] = [];
    const entries: AuditEntry[] = [];
    for (const op of this.log) {
      if (op.kind === "insert") {
        rows.push({ pendingId: op.pendingId, entry: op.entry, tempPath: op.temp });
      } else if (op.kind === "delete") {
        rows = rows.filter((r) => r.tempPath !== op.temp);
      } else {
        const row = rows.find((r) => r.pendingId === op.pendingId);
        if (row !== undefined) {
          rows = rows.filter((r) => r !== row);
          entries.push({ id: entries.length + 1, ...row.entry });
        }
      }
    }
    return { rows, entries };
  }
  insert(entry: AuditRecord & { revision: string }, temp: string): number {
    const pendingId = this.nextId++;
    this.commit({ kind: "insert", pendingId, entry, temp }, this.durableLevel);
    return pendingId;
  }
  deleteByTemp(temp: string): void {
    this.commit({ kind: "delete", temp }, this.durableLevel);
  }
  promote(pendingId: number): AuditEntry {
    const before = this.state().entries.length;
    if (!this.state().rows.some((r) => r.pendingId === pendingId)) throw new Error("no row");
    this.commit({ kind: "promote", pendingId }, this.connectionLevel());
    const entry = this.state().entries[before];
    if (entry === undefined) throw new Error("not promoted");
    return entry;
  }
  list(): PendingEntry[] {
    return this.state().rows;
  }
  tail(): number {
    return this.log.length - this.durableCount;
  }
  powerLoss(k: number): void {
    this.log = this.log.slice(0, this.durableCount + k);
    this.durableCount = this.log.length;
  }
}

interface World {
  fs: CrashFs;
  db: CrashPendingAudit;
  /** A writer whose fault hook throws PowerLoss right after the point `crashAt`. */
  writer(crashAt?: string): ConfigWriter;
}

let writers = 0;

function world(journal: Journal, durableLevel: number): World {
  const fs = new CrashFs();
  const db = new CrashPendingAudit(journal, durableLevel);
  return {
    fs,
    db,
    writer: (crashAt) => {
      const name = `w${++writers}`;
      let n = 0;
      return createConfigWriter({
        path: PATH,
        fs,
        holder: createConfigHolder(parseConfig(JSON.parse(FILE_A))),
        reloader: { revision: () => "", adopt: () => undefined },
        tempSuffix: () => `${name}-${++n}`,
        hasOpenIncidentFor: () => false,
        pending: db,
        now: () => 1,
        warn: () => undefined,
        fault: (point) => {
          if (point === crashAt) throw new PowerLoss(point);
        },
      });
    },
  };
}

const EDIT_B = { kind: "check", action: "create", body: check("b") } as const;

/** Run until a PowerLoss or the end; any other error is the write's normal answer. */
async function attempt(fn: () => Promise<unknown> | unknown): Promise<"crashed" | "done"> {
  try {
    await fn();
    return "done";
  } catch (err) {
    return err instanceof PowerLoss ? "crashed" : "done";
  }
}

/** A config write A -> B that crashes right after `point`. */
const writeB =
  (point?: string) =>
  async (w: World): Promise<void> => {
    await attempt(() => w.writer(point).apply(EDIT_B, REV_A, ACTOR));
  };

/** Fixture: a durable row and its durable temp file, the checks file A. */
function dropFixture(w: World): void {
  w.db.insert({ ...record(), revision: REV_B }, "/d/checks.json.old.tmp");
  w.fs.live.set("/d/checks.json.old.tmp", Buffer.from(FILE_B));
  w.fs.durable = new Map(w.fs.live);
}

/** Fixture: a durable row without temp file, the checks file B durable. */
function promoteFixture(w: World): void {
  w.db.insert({ ...record(), revision: REV_B }, "/d/checks.json.old.tmp");
  w.fs.live.set(PATH, Buffer.from(FILE_B));
  w.fs.durable = new Map(w.fs.live);
}

function record(): AuditRecord {
  return {
    at: 1,
    actor: ACTOR,
    action: "check.create",
    target: { kind: "check", id: "b" },
    revision: null,
  };
}

/** I1 and I2: write 1's step-6 sync fails, write 2 sends a stale If-Match. */
const interleaving =
  (failingSyncs: number[], point?: string) =>
  async (w: World): Promise<void> => {
    for (const s of failingSyncs) w.fs.failingSyncs.add(s);
    await attempt(() => w.writer().apply(EDIT_B, REV_A, ACTOR));
    await attempt(() => w.writer(point).apply(EDIT_B, REV_A, ACTOR));
  };

type Subset = "any" | "with-rename" | "without-rename";
interface Row {
  name: string;
  run: (w: World) => Promise<void>;
  subset?: Subset;
  file: "A" | "B";
  entries: 0 | 1;
}

const ROWS: Row[] = [
  { name: "writeTemp", run: writeB("writeTemp"), file: "A", entries: 0 },
  { name: "first fsyncDir (temp name)", run: writeB("fsyncDir.temp"), file: "A", entries: 0 },
  { name: "pending insert", run: writeB("pending.insert"), file: "A", entries: 0 },
  { name: "rename", run: writeB("rename"), subset: "without-rename", file: "A", entries: 0 },
  { name: "rename", run: writeB("rename"), subset: "with-rename", file: "B", entries: 1 },
  { name: "second fsyncDir", run: writeB("fsyncDir"), file: "B", entries: 1 },
  { name: "promote", run: writeB("promote"), file: "B", entries: 1 },
  { name: "no crash, 200, then power loss", run: writeB(), file: "B", entries: 1 },
  {
    name: "abort: the durable delete",
    run: async (w) => {
      w.fs.renameMode = "throw";
      await writeB("abort.delete")(w);
    },
    file: "A",
    entries: 0,
  },
  { name: "abort: remove(temp)", run: abortRemove, file: "A", entries: 0 },
  ...(["without-rename", "with-rename"] as const).map(
    (subset): Row => ({
      name: "rename moves, then throws EIO: the write's lstat(temp)",
      run: async (w) => {
        w.fs.renameMode = "move-throw";
        await writeB("lstat")(w);
      },
      subset,
      file: subset === "with-rename" ? "B" : "A",
      entries: subset === "with-rename" ? 1 : 0,
    }),
  ),
  ...(["delete", "remove"] as const).map(
    (step): Row => ({
      name: `resolver drop: ${step}`,
      run: async (w) => {
        dropFixture(w);
        await attempt(() => w.writer(`resolver.${step}`).resolvePending());
      },
      file: "A",
      entries: 0,
    }),
  ),
  ...(["fsyncDir", "promote"] as const).map(
    (step): Row => ({
      name: `resolver promote: ${step}`,
      run: async (w) => {
        promoteFixture(w);
        await attempt(() => w.writer(`resolver.${step}`).resolvePending());
      },
      file: "B",
      entries: 1,
    }),
  ),
  {
    name: "I1: crash right after write 2's resolver lstat",
    run: interleaving([2], "resolver.lstat"),
    subset: "without-rename",
    file: "A",
    entries: 0,
  },
  {
    name: "I1: crash right after write 2's resolver lstat",
    run: interleaving([2], "resolver.lstat"),
    subset: "with-rename",
    file: "B",
    entries: 1,
  },
  {
    name: "I1: crash right after write 2's 412",
    run: interleaving([2]),
    file: "B",
    entries: 1,
  },
  {
    name: "I2: crash right after write 2's 412",
    run: interleaving([2, 3]),
    subset: "without-rename",
    file: "A",
    entries: 0,
  },
  {
    name: "I2: crash right after write 2's 412",
    run: interleaving([2, 3]),
    subset: "with-rename",
    file: "B",
    entries: 1,
  },
  {
    name: "process crash after rename; power loss after the restart's promote",
    run: async (w) => {
      await writeB("rename")(w);
      await attempt(() => w.writer("resolver.promote").resolvePending());
    },
    file: "B",
    entries: 1,
  },
];

async function abortRemove(w: World): Promise<void> {
  w.fs.renameMode = "throw";
  await writeB("abort.remove")(w);
}

interface Cell {
  journal: Journal;
  mask: number;
  hasRename: boolean;
  hasUnlink: boolean;
  k: number;
  file: string;
  entries: number;
  rows: number;
  revisions: (string | null)[];
}

/** Every subset and every k of one scenario, each from a fresh start, then a restart. */
async function cells(
  run: (w: World) => Promise<void>,
  journal: Journal,
  durableLevel: number,
): Promise<Cell[]> {
  const probe = world(journal, durableLevel);
  await run(probe);
  const changes = probe.fs.changes;
  const tail = probe.db.tail();
  expect(changes.length).toBeLessThanOrEqual(3);
  expect(tail).toBeLessThanOrEqual(2);
  const out: Cell[] = [];
  for (let mask = 0; mask < 1 << changes.length; mask++) {
    for (let k = 0; k <= tail; k++) {
      const w = world(journal, durableLevel);
      await run(w);
      const chosen = (i: number): boolean => (mask & (1 << i)) !== 0;
      w.fs.powerLoss(chosen);
      w.db.powerLoss(k);
      w.writer().resolvePending();
      const { rows, entries } = w.db.state();
      out.push({
        journal,
        mask,
        hasRename: changes.some((c, i) => c.op === "rename" && chosen(i)),
        hasUnlink: changes.some((c, i) => c.op === "unlink" && chosen(i)),
        k,
        file: w.fs.file(),
        entries: entries.length,
        rows: rows.length,
        revisions: entries.map((e) => e.revision),
      });
    }
  }
  return out;
}

function matches(cell: Cell, subset: Subset | undefined): boolean {
  if (subset === "with-rename") return cell.hasRename;
  if (subset === "without-rename") return !cell.hasRename;
  return true;
}

/** The spec's invariants: no pending row, at most one entry, file B exactly with B's entry. */
function isConsistent(cell: Cell): boolean {
  const hasB = cell.revisions.includes(REV_B);
  return cell.rows === 0 && cell.entries <= 1 && (cell.file === "B") === hasB;
}

for (const row of ROWS) {
  for (const journal of ["wal", "delete"] as const) {
    test(`power loss right after ${row.name} (${row.subset ?? "any subset"}, ${journal})`, async () => {
      const all = (await cells(row.run, journal, 3)).filter((c) => matches(c, row.subset));
      expect(all.length).toBeGreaterThan(0);
      const wrong = all.filter(
        (c) => !isConsistent(c) || c.file !== row.file || c.entries !== row.entries,
      );
      expect(wrong).toEqual([]);
    });
  }
}

test("negative control: FULL in delete mode loses the abort delete while the unlink persists", async () => {
  const all = await cells(abortRemove, "delete", 2);
  const failing = all.filter((c) => !isConsistent(c) || c.file !== "A" || c.entries !== 0);
  expect(
    failing.map(({ journal, hasUnlink, k, file, entries }) => ({
      journal,
      hasUnlink,
      k,
      file,
      entries,
    })),
  ).toEqual([{ journal: "delete", hasUnlink: true, k: 1, file: "A", entries: 1 }]);
  const passing = all.filter((c) => !failing.includes(c));
  expect(
    passing.map(({ hasUnlink, k, file, entries }) => ({ hasUnlink, k, file, entries })),
  ).toEqual([
    { hasUnlink: false, k: 0, file: "A", entries: 0 },
    { hasUnlink: false, k: 1, file: "A", entries: 0 },
    { hasUnlink: false, k: 2, file: "A", entries: 0 },
    { hasUnlink: true, k: 0, file: "A", entries: 0 },
    { hasUnlink: true, k: 2, file: "A", entries: 0 },
  ]);
});
