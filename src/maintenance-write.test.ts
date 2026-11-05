import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditLog, createAuditLog } from "./audit-log.ts";
import { type CheckStore, createCheckStore } from "./check-store.ts";
import { createCheckWriter } from "./check-write.ts";
import { type Config, parseConfig } from "./config.ts";
import { type ConfigHolder, createConfigHolder } from "./config-holder.ts";
import { adminRevision } from "./config-reload.ts";
import { ConfigWriteError, type WriteActor } from "./config-write.ts";
import { openDb } from "./db.ts";
import { createMaintenanceStore, type MaintenanceStore } from "./maintenance-store.ts";
import {
  createMaintenanceWriter,
  type MaintenanceWriter,
  type MaintenanceWriterDeps,
  type WindowEdit,
} from "./maintenance-write.ts";
import { createWriteLock, type WriteLock } from "./write-lock.ts";

const ACTOR: WriteActor = { tokenId: null, name: "ops" };
const FILE_REV = "sha256-file-1";

let dir: string;
let db: Database;
let checks: CheckStore;
let store: MaintenanceStore;
let audit: AuditLog;
let holder: ConfigHolder;
let lock: WriteLock;
let fileRev: string;
let clock: number;
let writer: MaintenanceWriter;

const fileConfig = (maintenance: unknown[] = [], ids = ["a", "c"]): Config =>
  parseConfig({
    checks: ids.map((id) => ({ id, name: id, url: "https://example.com/", intervalMs: 60_000 })),
    maintenance,
  });

function build(overrides: Partial<MaintenanceWriterDeps> = {}): MaintenanceWriter {
  return createMaintenanceWriter({
    db,
    store,
    generation: checks,
    holder,
    fileRevision: () => fileRev,
    audit,
    lock,
    now: () => clock,
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-maintenance-write-"));
  db = openDb(join(dir, "pulse.db"));
  clock = 1_000;
  checks = createCheckStore({ db, now: () => clock });
  store = createMaintenanceStore({ db, now: () => clock });
  audit = createAuditLog(db);
  holder = createConfigHolder(fileConfig());
  lock = createWriteLock();
  fileRev = FILE_REV;
  writer = build();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rev = (): string => adminRevision(fileRev, checks.generation());
const win = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "w",
  checkIds: ["a"],
  start: 2_000,
  end: 3_000,
  note: "db upgrade",
  ...over,
});
const apply = (edit: WindowEdit) => writer.apply(edit, rev(), ACTOR);
const create = (over: Record<string, unknown> = {}) => apply({ action: "create", body: win(over) });

async function failure(p: Promise<unknown>): Promise<ConfigWriteError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConfigWriteError) return err;
    throw err;
  }
  throw new Error("expected a ConfigWriteError");
}

const auditCount = (): number => audit.query({ limit: 100 }).entries.length;

/** Everything a refused write must leave as it was. */
const state = () => ({
  list: store.list(),
  generation: checks.generation(),
  audit: auditCount(),
  effective: holder.get().maintenance,
  holderList: holder.windowDefinitions(),
});

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `k${i}`);

test("D2 counterexamples are invalid and change nothing", async () => {
  holder = createConfigHolder(fileConfig([], ["web", ...ids(51)]));
  writer = build();
  const cases: Record<string, unknown>[] = [
    win({ checkIds: [] }),
    win({ checkIds: ids(51) }),
    win({ checkIds: ["web", "web"] }),
    win({ start: 1.5 }),
    win({ start: -1 }),
    win({ start: 3_000, end: 3_000 }),
    win({ start: 3_000, end: 2_000 }),
    win({ start: "2026-01-01T00:00:00Z" }),
    win({ note: "" }),
    win({ note: "a".repeat(501) }),
    win({ note: "😀".repeat(251) }),
    win({ note: " x" }),
    win({ note: "x " }),
    win({ note: "a\nb" }),
    win({ note: "a\u0007b" }),
    ...["0", "12", "Web", "-a", "a".repeat(65), ""].map((id) => win({ id })),
    { checkId: "web", start: 2_000, end: 3_000, note: "old body" },
    { ...win(), extra: 1 },
  ];
  const before = state();
  for (const body of cases) {
    const err = await failure(
      apply({ action: "create", body: { ...body, checkIds: body.checkIds ?? ["web"] } }),
    );
    expect(err.code).toBe("invalid");
  }
  expect(state()).toEqual(before);
});

test("a check id that is not effective is refused with its index", async () => {
  holder = createConfigHolder(fileConfig([], ["web"]));
  writer = build();
  const err = await failure(create({ checkIds: ["web", "nope"] }));
  expect(err.code).toBe("invalid");
  expect(err.message).toBe("maintenance.checkIds[1] must reference a configured check");
});

test("50 ids, note lengths 1 and 500, 250 emoji and ids a and 64 characters succeed", async () => {
  holder = createConfigHolder(fileConfig([], ids(50)));
  writer = build();
  await create({ id: "a", checkIds: ids(50), note: "x" });
  await create({ id: "b".repeat(64), checkIds: ["k0"], note: "a".repeat(500) });
  await create({ id: "e", checkIds: ["k1"], note: "😀".repeat(250) });
  expect(store.list().map((d) => d.id)).toEqual(["a", "b".repeat(64), "e"]);
  expect(store.get("a")?.checkIds).toEqual(ids(50));
});

test("a database check, also a shadowed one, is a valid reference", async () => {
  checks.create({ id: "b", name: "b", url: "https://example.com/", intervalMs: 60_000 }, null);
  checks.create({ id: "a", name: "db a", url: "https://example.com/", intervalMs: 60_000 }, null);
  holder.setDefinitions(checks.list());
  const out = await create({ checkIds: ["a", "b"] });
  expect(out.entity).toEqual({
    id: "w",
    index: null,
    source: "database",
    checkIds: ["a", "b"],
    start: 2_000,
    end: 3_000,
    note: "db upgrade",
    phase: "planned",
  });
});

test("create, replace and delete keep creation order and update the holder", async () => {
  await create({ id: "w2" });
  clock = 1_500;
  await create({ id: "w1", checkIds: ["c"] });
  const before = store.get("w2")?.createdAt;
  clock = 1_800;
  const out = await apply({
    action: "replace",
    ref: "w2",
    body: win({ id: "w2", note: "edited" }),
  });
  expect(out.entity).toMatchObject({ id: "w2", note: "edited" });
  expect(store.get("w2")?.createdAt).toBe(before);
  expect(holder.get().maintenance).toEqual([
    { checkId: "a", start: 2_000, end: 3_000, note: "edited" },
    { checkId: "c", start: 2_000, end: 3_000, note: "db upgrade" },
  ]);
  const del = await apply({ action: "delete", ref: "w2" });
  expect(del.entity).toBeUndefined();
  expect(holder.windowDefinitions().map((d) => d.id)).toEqual(["w1"]);
});

test("phase at start-1, start and end is planned, current and past", async () => {
  clock = 1_999;
  expect((await create({ id: "p1" })).entity).toMatchObject({ phase: "planned" });
  clock = 2_000;
  expect((await create({ id: "p2" })).entity).toMatchObject({ phase: "current" });
  clock = 3_000;
  expect((await create({ id: "p3" })).entity).toMatchObject({ phase: "past" });
});

test("the 1000th create succeeds and the 1001st conflicts", async () => {
  for (let i = 0; i < 999; i++)
    store.create({ id: `w${i}`, checkIds: ["a"], start: 2_000, end: 3_000, note: "n" });
  await create({ id: "last" });
  expect(store.count()).toBe(1_000);
  const err = await failure(create({ id: "over" }));
  expect(err.code).toBe("conflict");
  expect(err.message).toBe("too many maintenance windows: delete past ones");
  expect(store.count()).toBe(1_000);
});

test("target rules: duplicates, file-only ids, shadowed and legacy indexes", async () => {
  await create({ id: "dup" });
  await create({ id: "w" });
  holder.set(
    fileConfig([
      {
        id: "w",
        checkId: "a",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
        note: "file note",
      },
      {
        id: "fileonly",
        checkId: "c",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
        note: "f",
      },
    ]),
  );
  const fileBefore = holder.file().maintenance;
  const cases: [WindowEdit, string, string][] = [
    [
      { action: "create", body: win({ id: "dup" }) },
      "conflict",
      'maintenance "dup" already exists',
    ],
    [
      { action: "create", body: win({ id: "fileonly" }) },
      "conflict",
      'maintenance "fileonly" already exists',
    ],
    [
      { action: "replace", ref: "fileonly", body: win({ id: "fileonly" }) },
      "conflict",
      'maintenance "fileonly" comes from the checks file; edit the file',
    ],
    [
      { action: "delete", ref: "fileonly" },
      "conflict",
      'maintenance "fileonly" comes from the checks file; edit the file',
    ],
    [
      { action: "replace", ref: "w", body: win() },
      "conflict",
      'maintenance "w" is shadowed by the checks file; only delete is allowed',
    ],
    [
      { action: "delete", ref: "0" },
      "conflict",
      "file maintenance windows are read-only; edit the checks file",
    ],
    [
      { action: "delete", ref: "1" },
      "conflict",
      "file maintenance windows are read-only; edit the checks file",
    ],
    [{ action: "delete", ref: "2" }, "not-found", 'unknown maintenance "2"'],
    [{ action: "delete", ref: "7" }, "not-found", 'unknown maintenance "7"'],
    [
      { action: "replace", ref: "nope", body: win({ id: "nope" }) },
      "not-found",
      'unknown maintenance "nope"',
    ],
    [{ action: "delete", ref: "nope" }, "not-found", 'unknown maintenance "nope"'],
  ];
  for (const [edit, code, message] of cases) {
    const before = state();
    const err = await failure(apply(edit));
    expect([err.code, err.message]).toEqual([code, message]);
    expect(state()).toEqual(before);
  }
  await apply({ action: "delete", ref: "w" });
  expect(store.get("w")).toBeNull();
  expect(holder.file().maintenance).toBe(fileBefore);
  expect(holder.get().maintenance.map((w) => w.note)).toEqual(["file note", "f", "db upgrade"]);
});

test("references are checked before target conflicts", async () => {
  await create();
  const err = await failure(create({ checkIds: ["nope"] }));
  expect(err.code).toBe("invalid");
});

test("a replace whose body id differs from the path is invalid", async () => {
  await create();
  const err = await failure(apply({ action: "replace", ref: "w", body: win({ id: "x" }) }));
  expect(err.code).toBe("invalid");
});

test("time boundary: create and replace accept the year 9999 end", async () => {
  const bounds = { start: 253402300799998, end: 253402300799999 };
  await create({ id: "edge", ...bounds });
  await create({ id: "r" });
  await apply({ action: "replace", ref: "r", body: win({ id: "r", ...bounds }) });
  expect(store.get("edge")).toMatchObject(bounds);
  expect(store.get("r")).toMatchObject(bounds);
});

test("time boundary: create and replace refuse ends after year 9999 and change nothing", async () => {
  await create({ id: "r" });
  for (const end of [253402300800000, 8640000000000000]) {
    const before = state();
    const created = await failure(create({ id: "new", end }));
    const replaced = await failure(
      apply({ action: "replace", ref: "r", body: win({ id: "r", end }) }),
    );
    expect([created.code, replaced.code]).toEqual(["invalid", "invalid"]);
    expect(state()).toEqual(before);
  }
});

test("old revisions after a check write, a file apply or a window write are stale", async () => {
  const checkWriter = createCheckWriter({
    db,
    store: checks,
    service: { upsertChecks: () => () => undefined },
    holder,
    fileRevision: () => fileRev,
    audit,
    lock,
    now: () => clock,
  });
  const expectStale = async (old: string, edit: WindowEdit) => {
    const before = state();
    const err = await failure(writer.apply(edit, old, ACTOR));
    expect(err.code).toBe("stale");
    expect(state()).toEqual(before);
  };
  let old = rev();
  await checkWriter.apply(
    {
      action: "create",
      body: { id: "b", name: "b", url: "https://example.com/", intervalMs: 60_000 },
    },
    old,
    ACTOR,
  );
  await expectStale(old, { action: "create", body: win() });
  old = rev();
  fileRev = "sha256-file-2";
  await expectStale(old, { action: "create", body: win() });
  old = rev();
  await create();
  await expectStale(old, { action: "delete", ref: "w" });
  // A window write stales a revision held for a check write.
  const forCheck = rev();
  await create({ id: "w2" });
  const err = await failure(checkWriter.apply({ action: "delete", ref: "b" }, forCheck, ACTOR));
  expect(err.code).toBe("stale");
});

test("two writes with one revision give one success and one stale", async () => {
  const r = rev();
  const results = await Promise.allSettled([
    writer.apply({ action: "create", body: win({ id: "x" }) }, r, ACTOR),
    writer.apply({ action: "create", body: win({ id: "y" }) }, r, ACTOR),
  ]);
  expect(results.map((x) => x.status).toSorted((p, q) => p.localeCompare(q))).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const rejected = results.find((x) => x.status === "rejected");
  expect(
    rejected?.status === "rejected" &&
      rejected.reason instanceof ConfigWriteError &&
      rejected.reason.code,
  ).toBe("stale");
  expect(store.count()).toBe(1);
});

test("each successful write adds exactly one audit entry without the note", async () => {
  await create();
  await apply({ action: "replace", ref: "w", body: win({ note: "second" }) });
  const last = rev();
  await apply({ action: "delete", ref: "w" });
  const entries = audit.query({ limit: 100 }).entries.toReversed();
  expect(entries.map((e) => [e.action, e.target, e.actor.name])).toEqual([
    ["maintenance.create", { kind: "maintenance", id: "w" }, "ops"],
    ["maintenance.replace", { kind: "maintenance", id: "w" }, "ops"],
    ["maintenance.delete", { kind: "maintenance", id: "w" }, "ops"],
  ]);
  expect(entries[2]?.revision).toBe(adminRevision(FILE_REV, 3));
  expect(entries[2]?.revision).not.toBe(last);
  expect(JSON.stringify(entries)).not.toContain("db upgrade");
  expect(JSON.stringify(entries)).not.toContain("second");
});

test("an audit failure rolls back the definition, generation and effective set", async () => {
  await create({ id: "keep" });
  const failing = build({
    audit: {
      record: () => {
        throw new Error("disk full: db upgrade");
      },
    },
  });
  const edits: WindowEdit[] = [
    { action: "create", body: win({ id: "new" }) },
    { action: "replace", ref: "keep", body: win({ id: "keep", note: "changed" }) },
    { action: "delete", ref: "keep" },
  ];
  for (const edit of edits) {
    const before = state();
    const err = await failure(failing.apply(edit, rev(), ACTOR));
    expect([err.code, err.message]).toEqual(["error", "audit log could not be written"]);
    expect(state()).toEqual(before);
  }
});

test("a store failure answers maintenance could not be stored and changes nothing", async () => {
  const failing = build({
    store: {
      ...store,
      create: () => {
        throw new Error("boom");
      },
    },
  });
  const before = state();
  const err = await failure(failing.apply({ action: "create", body: win() }, rev(), ACTOR));
  expect([err.code, err.message]).toEqual(["error", "maintenance could not be stored"]);
  expect(state()).toEqual(before);
});

test("database writes leave the checks file untouched in every file state", async () => {
  const path = join(dir, "checks.json");
  const states: [string, string, number][] = [
    ["invalid", "{", 0o644],
    ["written-not-applied", JSON.stringify({ checks: [] }), 0o644],
    ["read-only", "{}", 0o444],
    ["unreadable", "{}", 0o000],
  ];
  for (const [name, content, mode] of states) {
    writeFileSync(path, content);
    chmodSync(path, mode);
    await create({ id: name });
    await apply({ action: "replace", ref: name, body: win({ id: name, note: "edit" }) });
    await apply({ action: "delete", ref: name });
    chmodSync(path, 0o644);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(fileRev).toBe(FILE_REV);
  }
  expect(checks.generation()).toBe(12);
});
