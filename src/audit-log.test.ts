import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditPendingNotFoundError,
  type AuditRecord,
  createAuditLog,
  createPendingAudit,
} from "./audit-log.ts";
import { openDb, withDurableCommit } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-audit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REV = `sha256-${"a".repeat(64)}`;
const TOKEN = `tok_${"0".repeat(24)}`;

function record(at: number, over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    at,
    actor: { tokenId: TOKEN, name: "ops" },
    action: "check.create",
    target: { kind: "check", id: `c${at}` },
    revision: null,
    ...over,
  };
}

function synchronous(db: Database): number {
  return (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
}

/** A delete-mode file database at the current schema (openDb would switch it to WAL). */
function deleteModeDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = DELETE");
  db.close();
  const migrated = openDb(path, MIGRATIONS);
  migrated.close();
  const plain = new Database(path);
  plain.run("PRAGMA journal_mode = DELETE");
  return plain;
}

test("insert and deleteByTemp each run through the durable wrapper once, promote not at all", () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  const pending = createPendingAudit(db, (fn) => {
    calls.push("durable");
    return fn();
  });
  pending.insert({ ...record(5), revision: REV }, "/x/a.tmp");
  expect(calls).toEqual(["durable"]);
  pending.insert({ ...record(6), revision: REV }, "/x/b.tmp");
  calls.length = 0;
  pending.deleteByTemp("/x/a.tmp");
  expect(calls).toEqual(["durable"]);
  calls.length = 0;
  const [left] = pending.list();
  expect(left?.tempPath).toBe("/x/b.tmp");
  pending.promote(left?.pendingId ?? 0);
  expect(calls).toEqual([]);
  db.close();
});

for (const mode of ["wal", "delete"] as const) {
  test(`with withDurableCommit, insert and deleteByTemp run at synchronous 3 on a ${mode} file`, () => {
    const path = join(dir, "pulse.db");
    const db = mode === "wal" ? openDb(path) : deleteModeDb(path);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      mode,
    );
    const seen: number[] = [];
    const pending = createPendingAudit(db, (fn) =>
      withDurableCommit(db, () => {
        seen.push(synchronous(db));
        return fn();
      }),
    );
    pending.insert({ ...record(5), revision: REV }, "/x/a.tmp");
    pending.deleteByTemp("/x/a.tmp");
    expect(seen).toEqual([3, 3]);
    expect(pending.list()).toEqual([]);
    db.close();
  });
}

test("the default durable wrapper is withDurableCommit: it throws inside a transaction", () => {
  const db = openDb(":memory:");
  const pending = createPendingAudit(db);
  expect(() =>
    db.transaction(() => pending.insert({ ...record(5), revision: REV }, "/x/a.tmp"))(),
  ).toThrow("withDurableCommit must run outside a transaction");
  db.close();
});

test("promote assigns the next audit_log id, keeps at and removes the pending row", () => {
  const db = openDb(":memory:");
  const log = createAuditLog(db);
  const pending = createPendingAudit(db);
  log.record(record(1));
  log.record(record(2));
  pending.insert(
    {
      ...record(7, { action: "maintenance.replace", target: { kind: "maintenance", id: "0" } }),
      revision: REV,
    },
    "/x/a.tmp",
  );
  pending.insert({ ...record(8), revision: REV }, "/x/b.tmp");
  const list = pending.list();
  expect(list.map((p) => p.tempPath)).toEqual(["/x/a.tmp", "/x/b.tmp"]);
  const entry = pending.promote(list[0]?.pendingId ?? 0);
  expect(entry).toEqual({
    id: 3,
    at: 7,
    actor: { tokenId: TOKEN, name: "ops" },
    action: "maintenance.replace",
    target: { kind: "maintenance", id: "0" },
    revision: REV,
  });
  expect(pending.list().map((p) => p.tempPath)).toEqual(["/x/b.tmp"]);
  expect(log.query({ limit: 10 }).entries.map((e) => e.id)).toEqual([3, 2, 1]);
  expect(() => pending.promote(9999)).toThrow(AuditPendingNotFoundError);
  db.close();
});

test("a query pages 250 entries by id descending with a before cursor", () => {
  const db = openDb(":memory:");
  const log = createAuditLog(db);
  for (let i = 1; i <= 250; i++) log.record(record(i));
  const ids = (from: number, to: number): number[] =>
    Array.from({ length: from - to + 1 }, (_, i) => from - i);
  const first = log.query({ limit: 100 });
  expect(first.entries.map((e) => e.id)).toEqual(ids(250, 151));
  expect(first.nextBefore).toBe(151);
  const second = log.query({ limit: 100, before: 151 });
  expect(second.entries.map((e) => e.id)).toEqual(ids(150, 51));
  expect(second.nextBefore).toBe(51);
  const third = log.query({ limit: 100, before: 51 });
  expect(third.entries.map((e) => e.id)).toEqual(ids(50, 1));
  expect(third.nextBefore).toBeNull();
  db.close();
});

test("query filters on actor, action, target, since inclusive and until exclusive", () => {
  const db = openDb(":memory:");
  const log = createAuditLog(db);
  log.record(record(10));
  log.record(record(20, { actor: { tokenId: null, name: "legacy" } }));
  log.record(record(30, { action: "check.delete", target: { kind: "check", id: "x" } }));
  log.record(record(40, { action: "token.revoke", target: { kind: "token", id: TOKEN } }));
  const ids = (q: Parameters<typeof log.query>[0]): number[] =>
    log.query(q).entries.map((e) => e.id);
  expect(ids({ limit: 10, actor: TOKEN })).toEqual([4, 3, 1]);
  expect(ids({ limit: 10, action: "check.delete" })).toEqual([3]);
  expect(ids({ limit: 10, targetKind: "token" })).toEqual([4]);
  expect(ids({ limit: 10, targetId: "x" })).toEqual([3]);
  expect(ids({ limit: 10, since: 20, until: 40 })).toEqual([3, 2]);
  expect(log.query({ limit: 10, since: 50 })).toEqual({ entries: [], nextBefore: null });
  db.close();
});

test("batches walk by id ascending up to the largest id at the start", () => {
  const db = openDb(":memory:");
  const log = createAuditLog(db);
  expect([...log.batches({})]).toEqual([]);
  for (let i = 1; i <= 5; i++) log.record(record(i));
  const sizes: number[][] = [];
  for (const batch of log.batches({}, 2)) {
    sizes.push(batch.map((e) => e.id));
    log.record(record(100));
  }
  expect(sizes).toEqual([[1, 2], [3, 4], [5]]);
  expect([...log.batches({ since: 100 })].flat()).toHaveLength(3);
  db.close();
});

test("record inside an outer transaction rolls back with it", () => {
  const db = openDb(":memory:");
  const log = createAuditLog(db);
  expect(() =>
    db.transaction(() => {
      log.record(record(1));
      throw new Error("later step failed");
    })(),
  ).toThrow("later step failed");
  expect(log.query({ limit: 10 }).entries).toEqual([]);
  db.close();
});
