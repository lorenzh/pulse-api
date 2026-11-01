import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@lorenzh/pulse-contract";
import { type AuditRecord, createPendingAudit, type PendingAudit } from "./audit-log.ts";
import { parseConfig } from "./config.ts";
import { nodeConfigFs } from "./config-fs.ts";
import { createConfigHolder } from "./config-holder.ts";
import { type ConfigWriter, createConfigWriter, type WriteFs } from "./config-write.ts";
import { openDb } from "./db.ts";

const DIR = "/d";
const PATH = "/d/checks.json";
const ACTOR = { tokenId: "tok_1", name: "ops" };
const FILE_A = `${JSON.stringify({ checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }] }, null, 2)}\n`;
const STORED_MSG =
  "checks file stored; its audit entry is pending and is resolved at the next write or restart";

const sha = (bytes: string | Buffer): string =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

const checkEdit = (id: string) =>
  ({
    kind: "check",
    action: "create",
    body: { id, name: id.toUpperCase(), url: `https://${id}.example/`, intervalMs: 60000 },
  }) as const;

const errno = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });

/** One directory in memory; every call is logged as `name(arg)`. */
class MemFs implements WriteFs {
  files = new Map<string, Buffer>();
  log: string[] = [];
  renameMode: "ok" | "throw" | "move-throw" = "ok";
  /** Codes thrown by the next `fsyncDir` calls, one each. */
  fsyncFailures: string[] = [];
  lstatCode = new Map<string, string>();

  constructor(file = FILE_A) {
    this.files.set(PATH, Buffer.from(file));
  }
  readFile(path: string): Buffer {
    this.log.push(`readFile(${path})`);
    const bytes = this.files.get(path);
    if (bytes === undefined) throw errno("ENOENT");
    return bytes;
  }
  writeTemp(temp: string, data: Buffer): void {
    this.log.push(`writeTemp(${temp})`);
    this.files.set(temp, data);
  }
  fsyncDir(dir: string): void {
    this.log.push(`fsyncDir(${dir})`);
    const code = this.fsyncFailures.shift();
    if (code !== undefined) throw errno(code);
  }
  rename(from: string, to: string): void {
    this.log.push(`rename(${from}, ${to})`);
    if (this.renameMode === "throw") {
      this.renameMode = "ok";
      throw errno("EIO");
    }
    const bytes = this.files.get(from);
    if (bytes === undefined) throw errno("ENOENT");
    this.files.delete(from);
    this.files.set(to, bytes);
    if (this.renameMode === "move-throw") {
      this.renameMode = "ok";
      throw errno("EIO");
    }
  }
  remove(path: string): void {
    this.log.push(`remove(${path})`);
    this.files.delete(path);
  }
  lstat(path: string): void {
    this.log.push(`lstat(${path})`);
    const code = this.lstatCode.get(path);
    if (code !== undefined) throw errno(code);
    if (!this.files.has(path)) throw errno("ENOENT");
  }
  assertWritable(): void {}
  temps(): string[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".tmp"));
  }
  text(): string {
    return this.files.get(PATH)?.toString() ?? "";
  }
}

interface Row {
  pendingId: number;
  entry: AuditRecord & { revision: string };
  tempPath: string;
}

/** A PendingAudit in memory that logs into the fs log, so both orders read as one. */
class FakePending implements PendingAudit {
  rows: Row[] = [];
  entries: AuditEntry[] = [];
  insertMode: "ok" | "throw" | "commit-throw" = "ok";
  deleteCode: string | undefined;
  isPromoteBroken = false;
  rowsAtRemove: number[] = [];
  private nextPending = 1;
  private readonly fs: MemFs;

  constructor(fs: MemFs) {
    this.fs = fs;
    const remove = fs.remove.bind(fs);
    fs.remove = (path) => {
      this.rowsAtRemove.push(this.rows.length);
      remove(path);
    };
  }
  insert(entry: AuditRecord & { revision: string }, tempPath: string): number {
    this.fs.log.push("pending.insert(durable)");
    if (this.insertMode === "throw") throw errno("SQLITE_IOERR");
    const pendingId = this.nextPending++;
    this.rows.push({ pendingId, entry, tempPath });
    if (this.insertMode === "commit-throw") throw errno("SQLITE_IOERR");
    return pendingId;
  }
  deleteByTemp(tempPath: string): void {
    this.fs.log.push("pending.deleteByTemp(durable)");
    if (this.deleteCode !== undefined) {
      const code = this.deleteCode;
      this.deleteCode = undefined;
      throw errno(code);
    }
    this.rows = this.rows.filter((r) => r.tempPath !== tempPath);
  }
  promote(pendingId: number): AuditEntry {
    this.fs.log.push("pending.promote");
    if (this.isPromoteBroken) {
      this.isPromoteBroken = false;
      throw errno("SQLITE_IOERR");
    }
    const row = this.rows.find((r) => r.pendingId === pendingId);
    if (row === undefined) throw new Error("no row");
    this.rows = this.rows.filter((r) => r !== row);
    const entry = { id: this.entries.length + 1, ...row.entry };
    this.entries.push(entry);
    return entry;
  }
  list(): Row[] {
    this.fs.log.push("pending.list");
    return [...this.rows];
  }
  revisions(): (string | null)[] {
    return this.entries.map((e) => e.revision);
  }
}

interface Harness {
  fs: MemFs;
  pending: FakePending;
  warns: string[];
  writer: ConfigWriter;
}

let suffix = 0;

function harness(fs = new MemFs(), pending = new FakePending(fs), warns: string[] = []): Harness {
  const writer = createConfigWriter({
    path: PATH,
    fs,
    holder: createConfigHolder(parseConfig(JSON.parse(FILE_A))),
    reloader: { revision: () => "", adopt: () => undefined },
    tempSuffix: () => `t${++suffix}`,
    hasOpenIncidentFor: () => false,
    pending,
    now: () => 1000,
    warn: (line) => warns.push(line),
  });
  return { fs, pending, warns, writer };
}

/** A write of check `id` based on the current file; resolves to the status-like outcome. */
async function write(h: Harness, id: string, ifMatch = sha(h.fs.text())): Promise<string> {
  try {
    await h.writer.apply(checkEdit(id), ifMatch, ACTOR);
    return "200";
  } catch (err) {
    const code = err instanceof Error ? Reflect.get(err, "code") : undefined;
    const message = err instanceof Error ? err.message : "";
    return `${String(code)}: ${message}`;
  }
}

function from(log: string[], name: string): string[] {
  return log.slice(log.findIndex((l) => l.startsWith(name)));
}

beforeEach(() => {
  suffix = 0;
});

test("success call order: temp name synced before the insert, promote after the second sync", async () => {
  const h = harness();
  expect(await write(h, "b")).toBe("200");
  expect(from(h.fs.log, "writeTemp")).toEqual([
    "writeTemp(/d/checks.json.t1.tmp)",
    "fsyncDir(/d)",
    "pending.insert(durable)",
    "readFile(/d/checks.json)",
    "rename(/d/checks.json.t1.tmp, /d/checks.json)",
    "fsyncDir(/d)",
    "pending.promote",
  ]);
  expect(h.pending.entries).toEqual([
    {
      id: 1,
      at: 1000,
      actor: ACTOR,
      action: "check.create",
      target: { kind: "check", id: "b" },
      revision: sha(h.fs.text()),
    },
  ]);
});

test("failure call order: a rename that throws EIO aborts durably before the removal", async () => {
  const h = harness();
  h.fs.renameMode = "throw";
  expect(await write(h, "b")).toBe("error: checks file could not be written (EIO)");
  expect(from(h.fs.log, "writeTemp")).toEqual([
    "writeTemp(/d/checks.json.t1.tmp)",
    "fsyncDir(/d)",
    "pending.insert(durable)",
    "readFile(/d/checks.json)",
    "rename(/d/checks.json.t1.tmp, /d/checks.json)",
    "lstat(/d/checks.json.t1.tmp)",
    "pending.deleteByTemp(durable)",
    "remove(/d/checks.json.t1.tmp)",
  ]);
  expect(h.pending.rowsAtRemove).toEqual([0]);
  expect(h.fs.text()).toBe(FILE_A);
  expect(h.pending.entries).toEqual([]);
});

/** A pending row for a write to B whose temp file is missing; the checks file is B. */
function rowForB(h: Harness, temp = "/d/checks.json.old.tmp"): string {
  const b = `${JSON.stringify({ checks: [{ id: "b", name: "B", url: "https://b.example/", intervalMs: 60000 }] }, null, 2)}\n`;
  h.fs.files.set(PATH, Buffer.from(b));
  h.pending.insert({ ...rec(), revision: sha(b) }, temp);
  return sha(b);
}

function rec(): AuditRecord {
  return {
    at: 1,
    actor: ACTOR,
    action: "check.create",
    target: { kind: "check", id: "b" },
    revision: null,
  };
}

test("resolver call order: candidates sync once before their promotes; a present temp is dropped", async () => {
  const one = harness();
  rowForB(one);
  one.fs.log = [];
  await write(one, "c");
  expect(one.fs.log.slice(0, 4)).toEqual([
    "pending.list",
    "lstat(/d/checks.json.old.tmp)",
    "fsyncDir(/d)",
    "pending.promote",
  ]);

  const two = harness();
  rowForB(two, "/d/checks.json.x.tmp");
  rowForB(two, "/d/checks.json.y.tmp");
  two.fs.log = [];
  two.writer.resolvePending();
  expect(two.fs.log).toEqual([
    "pending.list",
    "lstat(/d/checks.json.x.tmp)",
    "lstat(/d/checks.json.y.tmp)",
    "fsyncDir(/d)",
    "pending.promote",
    "pending.promote",
  ]);

  const present = harness();
  present.pending.insert({ ...rec(), revision: "sha256-x" }, "/d/checks.json.z.tmp");
  present.fs.files.set("/d/checks.json.z.tmp", Buffer.from("x"));
  present.fs.log = [];
  present.writer.resolvePending();
  expect(present.fs.log).toEqual([
    "pending.list",
    "lstat(/d/checks.json.z.tmp)",
    "pending.deleteByTemp(durable)",
    "remove(/d/checks.json.z.tmp)",
  ]);
  expect(present.pending.rows).toEqual([]);
  expect(present.pending.entries).toEqual([]);
});

test("a pending insert failure answers 500, keeps the file and leaves no temp file", async () => {
  const h = harness();
  h.pending.insertMode = "throw";
  expect(await write(h, "b")).toBe("error: audit log could not be written");
  expect(h.fs.text()).toBe(FILE_A);
  expect(h.fs.temps()).toEqual([]);
});

test("an insert that commits and then throws is deleted by its temp path before the removal", async () => {
  const h = harness();
  h.pending.insertMode = "commit-throw";
  expect(await write(h, "b")).toBe("error: audit log could not be written");
  expect(h.pending.rows).toEqual([]);
  expect(h.pending.rowsAtRemove).toEqual([0]);
  expect(h.pending.entries).toEqual([]);
  expect(h.fs.temps()).toEqual([]);
  expect(h.fs.text()).toBe(FILE_A);
  harness(h.fs, h.pending).writer.resolvePending();
  expect(h.pending.entries).toEqual([]);
});

test("a promote failure answers the pending 500; a restart promotes exactly the entry of B", async () => {
  const h = harness();
  h.pending.isPromoteBroken = true;
  expect(await write(h, "b")).toBe(`error: ${STORED_MSG}`);
  const revB = sha(h.fs.text());
  expect(h.pending.entries).toEqual([]);
  harness(h.fs, h.pending).writer.resolvePending();
  expect(h.pending.revisions()).toEqual([revB]);
  expect(h.pending.rows).toEqual([]);
});

test("a promote failure is resolved by the next write B -> C: entries B then C", async () => {
  const h = harness();
  h.pending.isPromoteBroken = true;
  await write(h, "b");
  const revB = sha(h.fs.text());
  expect(await write(h, "c")).toBe("200");
  expect(h.pending.revisions()).toEqual([revB, sha(h.fs.text())]);
  expect(h.pending.entries.map((e) => e.id)).toEqual([1, 2]);
  expect(h.pending.rows).toEqual([]);
});

test("an external restore A -> B -> A keeps exactly the entry of B", async () => {
  const h = harness();
  h.pending.isPromoteBroken = true;
  await write(h, "b");
  const revB = sha(h.fs.text());
  h.fs.files.set(PATH, Buffer.from(FILE_A));
  harness(h.fs, h.pending).writer.resolvePending();
  expect(h.pending.revisions()).toEqual([revB]);
});

test("crash-before-rename fixture: the row and the temp file are dropped, the file stays A", () => {
  const h = harness();
  h.pending.insert({ ...rec(), revision: "sha256-b" }, "/d/checks.json.c.tmp");
  h.fs.files.set("/d/checks.json.c.tmp", Buffer.from("B"));
  h.writer.resolvePending();
  expect(h.pending.entries).toEqual([]);
  expect(h.pending.rows).toEqual([]);
  expect(h.fs.temps()).toEqual([]);
  expect(h.fs.text()).toBe(FILE_A);
});

test("crash-after-rename fixture: the row is promoted with the revision of B", () => {
  const h = harness();
  const revB = rowForB(h);
  h.writer.resolvePending();
  expect(h.pending.revisions()).toEqual([revB]);
});

test("a rename that moves and then throws EIO keeps the row; the next write promotes it", async () => {
  const h = harness();
  h.fs.renameMode = "move-throw";
  expect(await write(h, "b", sha(FILE_A))).toBe("error: checks file could not be written (EIO)");
  expect(h.fs.log).not.toContain("pending.deleteByTemp(durable)");
  expect(h.fs.log.some((l) => l.startsWith("remove("))).toBe(false);
  expect(h.pending.rows).toHaveLength(1);
  expect(h.pending.entries).toEqual([]);
  const revB = sha(h.fs.text());
  expect(await write(h, "c")).toBe("200");
  expect(h.pending.revisions()).toEqual([revB, sha(h.fs.text())]);
  expect(h.fs.text()).toContain('"c"');
});

test("a failing resolver sync promotes nothing; a later pass promotes B between C and D", async () => {
  const h = harness();
  const revB = rowForB(h);
  h.fs.fsyncFailures = ["EIO"];
  expect(await write(h, "c")).toBe("200");
  const revC = sha(h.fs.text());
  expect(h.fs.log.filter((l) => l === "pending.promote")).toHaveLength(1);
  expect(h.warns).toEqual(["audit pending entry unresolved (EIO)"]);
  expect(h.pending.revisions()).toEqual([revC]);
  expect(h.pending.rows.map((r) => r.entry.revision)).toEqual([revB]);
  expect(await write(h, "d")).toBe("200");
  expect(h.pending.revisions()).toEqual([revC, revB, sha(h.fs.text())]);
  expect(h.pending.entries.map((e) => e.id)).toEqual([1, 2, 3]);
  expect(h.pending.rows).toEqual([]);
});

test("an abort delete that throws keeps the temp file; the next write drops both", async () => {
  const h = harness();
  h.fs.renameMode = "throw";
  h.pending.deleteCode = "SQLITE_IOERR";
  expect(await write(h, "b")).toBe("error: checks file could not be written (EIO)");
  expect(h.fs.log.some((l) => l.startsWith("remove("))).toBe(false);
  expect(h.fs.temps()).toEqual(["/d/checks.json.t1.tmp"]);
  expect(h.pending.rows).toHaveLength(1);
  expect(h.warns).toEqual(["audit pending entry kept (SQLITE_IOERR)"]);
  expect(await write(h, "c")).toBe("200");
  expect(h.pending.rows).toEqual([]);
  expect(h.fs.temps()).toEqual([]);
  expect(h.pending.revisions()).toEqual([sha(h.fs.text())]);
});

test("an lstat EACCES keeps the row, warns with the code only, and the write proceeds", async () => {
  const h = harness();
  h.pending.insert({ ...rec(), revision: "sha256-b" }, "/d/checks.json.e.tmp");
  h.fs.lstatCode.set("/d/checks.json.e.tmp", "EACCES");
  expect(await write(h, "c")).toBe("200");
  expect(h.pending.rows.map((r) => r.tempPath)).toEqual(["/d/checks.json.e.tmp"]);
  expect(h.warns).toEqual(["audit pending entry unresolved (EACCES)"]);
  expect(h.warns.join()).not.toContain("/d");
});

test("interleaving: write 2 with a stale If-Match syncs before it promotes, then answers 412", async () => {
  const h = harness();
  // The step-6 sync is the second fsyncDir of write 1.
  const realSync = h.fs.fsyncDir.bind(h.fs);
  let syncs = 0;
  h.fs.fsyncDir = (d) => {
    syncs += 1;
    if (syncs === 2) {
      h.fs.log.push(`fsyncDir(${d})`);
      throw errno("EIO");
    }
    realSync(d);
  };
  expect(await write(h, "b")).toBe("error: checks file could not be written (EIO)");
  expect(h.pending.rows).toHaveLength(1);
  h.fs.log = [];
  expect(await write(h, "c", sha(FILE_A))).toMatch(/^stale: /);
  expect(h.fs.log).toEqual([
    "pending.list",
    "lstat(/d/checks.json.t1.tmp)",
    "fsyncDir(/d)",
    "pending.promote",
    "readFile(/d/checks.json)",
  ]);
});

// ---- real files and SQLite ----

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pulse-cw-audit-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("a pending row from another working directory is recovered by its absolute temp path", async () => {
  const work = join(tmp, "work");
  const other = join(tmp, "other");
  mkdirSync(work);
  mkdirSync(other);
  writeFileSync(join(work, "checks.json"), FILE_A);
  const dbPath = join(tmp, "pulse.db");
  const before = process.cwd();
  class PowerLoss extends Error {
    override name = "PowerLoss";
  }
  const writerIn = (db: Database, fault?: (p: string) => void): ConfigWriter =>
    createConfigWriter({
      path: "checks.json",
      fs: nodeConfigFs,
      holder: createConfigHolder(parseConfig(JSON.parse(FILE_A))),
      reloader: { revision: () => "", adopt: () => undefined },
      tempSuffix: () => "crash",
      hasOpenIncidentFor: () => false,
      pending: createPendingAudit(db),
      now: () => 1000,
      warn: () => undefined,
      ...(fault === undefined ? {} : { fault }),
    });
  try {
    process.chdir(work);
    const db1 = openDb(dbPath);
    const crash = (p: string): void => {
      if (p === "pending.insert") throw new PowerLoss("crash");
    };
    await expect(writerIn(db1, crash).apply(checkEdit("b"), sha(FILE_A), ACTOR)).rejects.toThrow(
      PowerLoss,
    );
    const stored = db1.query("SELECT temp_path FROM audit_pending").all() as {
      temp_path: string;
    }[];
    expect(stored).toEqual([{ temp_path: join(work, "checks.json.crash.tmp") }]);
    db1.close();

    process.chdir(other);
    const db2 = openDb(dbPath);
    writerIn(db2).resolvePending();
    expect(db2.query("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    expect(db2.query("SELECT COUNT(*) AS n FROM audit_pending").get()).toEqual({ n: 0 });
    db2.close();
  } finally {
    process.chdir(before);
  }
  expect(readFileSync(join(work, "checks.json"), "utf8")).toBe(FILE_A);
  expect(readdirSync(work)).toEqual(["checks.json"]);
});

test("the real store records the entry of a write in audit_log", async () => {
  const path = join(tmp, "checks.json");
  writeFileSync(path, FILE_A);
  const real = openDb(join(tmp, "p.db"));
  const writer = createConfigWriter({
    path,
    fs: nodeConfigFs,
    holder: createConfigHolder(parseConfig(JSON.parse(FILE_A))),
    reloader: { revision: () => "", adopt: () => undefined },
    tempSuffix: () => "s",
    hasOpenIncidentFor: () => false,
    pending: createPendingAudit(real),
    now: () => 5,
    warn: () => undefined,
  });
  await writer.apply(checkEdit("b"), sha(FILE_A), ACTOR);
  expect(real.query("SELECT revision, target_id FROM audit_log").all()).toEqual([
    { revision: sha(readFileSync(path)), target_id: "b" },
  ]);
  real.close();
});
