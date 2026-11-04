import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check } from "@lorenzh/pulse-contract";
import {
  type CheckStore,
  CheckStoreError,
  createCheckStore,
  type FileSnapshot,
} from "./check-store.ts";
import { openDb } from "./db.ts";

let dir: string;
let path: string;
let db: Database;
let clock: number;
let store: CheckStore;

function open(): void {
  db = openDb(path);
  store = createCheckStore({ db, now: () => clock });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-check-store-"));
  path = join(dir, "pulse.db");
  clock = 1_000;
  open();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reopen = (): void => {
  db.close();
  open();
};

const HB_SECRET = "hb-db-sentinel-0123456789";
const HB_DIGEST = createHash("sha256").update(HB_SECRET).digest("hex");

const http = (id: string, name = "Web"): Check => ({
  id,
  name,
  type: "http",
  url: "https://example.com/",
  method: "POST",
  intervalMs: 60_000,
  headers: { "x-lit": "lit-db-sentinel-1", "x-env": { env: "PULSE_HEADER_SENTINEL_DB_ENV" } },
  body: "body-db-sentinel-1",
});
const heartbeat: Check = { id: "hb", name: "Nightly", type: "heartbeat", period: 60_000, grace: 0 };

const snapshot: FileSnapshot = {
  revision: "sha256-abc",
  appliedAt: 5_000,
  checks: [http("file-web"), { ...heartbeat, id: "file-hb" }],
  secretDigests: { "file-hb": HB_DIGEST },
  components: [],
  maintenance: [],
};

test("definitions keep creation order across replace, delete and reopen", () => {
  store.create(http("b"), null);
  clock = 2_000;
  store.create(http("a"), null);
  clock = 3_000;
  store.create(heartbeat, HB_DIGEST);
  clock = 4_000;
  const replaced = store.replace(http("b", "Web 2"), null);
  expect(replaced).toEqual({
    check: http("b", "Web 2"),
    secretSha256: null,
    createdAt: 1_000,
    updatedAt: 4_000,
  });
  expect(store.delete("a")).toBe(true);
  expect(store.delete("a")).toBe(false);
  expect(store.replace(http("missing"), null)).toBeNull();
  reopen();
  expect(store.list().map((d) => [d.check.id, d.check.name, d.createdAt, d.updatedAt])).toEqual([
    ["b", "Web 2", 1_000, 4_000],
    ["hb", "Nightly", 3_000, 3_000],
  ]);
  expect(store.get("hb")?.secretSha256).toBe(HB_DIGEST);
  expect(store.get("a")).toBeNull();
});

test("generation starts at 0, rises by one and survives reopen", () => {
  expect(store.generation()).toBe(0);
  expect(store.bumpGeneration()).toBe(1);
  expect(store.bumpGeneration()).toBe(2);
  reopen();
  expect(store.generation()).toBe(2);
});

test("the file snapshot is null at first and survives reopen", () => {
  expect(store.snapshot()).toBeNull();
  store.writeSnapshot(snapshot);
  reopen();
  expect(store.snapshot()).toEqual(snapshot);
  const row = db.query("SELECT file_revision, file_applied_at FROM config_state").get();
  expect(row).toEqual({ file_revision: "sha256-abc", file_applied_at: 5_000 });
});

test("a rollback of the caller's transaction leaves every store value unchanged", () => {
  store.create(http("keep"), null);
  store.writeSnapshot(snapshot);
  expect(() =>
    db.transaction(() => {
      store.create(http("new"), null);
      store.replace(http("keep", "Changed"), null);
      store.bumpGeneration();
      store.writeSnapshot({ ...snapshot, revision: "sha256-def" });
      store.delete("keep");
      throw new Error("injected");
    })(),
  ).toThrow("injected");
  reopen();
  expect(store.list().map((d) => [d.check.id, d.check.name])).toEqual([["keep", "Web"]]);
  expect(store.generation()).toBe(0);
  expect(store.snapshot()?.revision).toBe("sha256-abc");
});

test("a duplicate id is refused", () => {
  store.create(http("x"), null);
  expect(() => store.create(http("x"), null)).toThrow(CheckStoreError);
});

const KEEP_HEADER = { ...http("k"), headers: { "x-lit": { keep: true } } } as unknown as Check;
const KEEP_BODY = { ...http("k"), body: { keep: true } } as unknown as Check;
const PLAIN_SECRET = { ...heartbeat, secret: HB_SECRET } as unknown as Check;

test.each([
  ["keep header", KEEP_HEADER, null],
  ["keep body", KEEP_BODY, null],
  ["plaintext secret", PLAIN_SECRET, HB_DIGEST],
  ["heartbeat without digest", heartbeat, null],
  ["plaintext as digest", heartbeat, HB_SECRET],
  ["digest on http", http("d"), HB_DIGEST],
] as const)("an unmaterialized definition is refused: %s", (_label, check, digest) => {
  expect(() => store.create(check, digest)).toThrow(CheckStoreError);
  store.create(http(check.id === "hb" ? "other" : "hb"), null);
  expect(() => store.replace({ ...check, id: check.id === "hb" ? "other" : "hb" }, digest)).toThrow(
    CheckStoreError,
  );
  const text = JSON.stringify(db.query("SELECT * FROM check_definitions").all());
  expect(text).not.toContain("keep");
  expect(text).not.toContain(HB_SECRET);
});

test.each<[string, FileSnapshot]>([
  ["keep header", { ...snapshot, checks: [KEEP_HEADER] }],
  [
    "plaintext secret in a check",
    { ...snapshot, checks: [PLAIN_SECRET], secretDigests: { hb: HB_DIGEST } },
  ],
  ["plaintext as digest", { ...snapshot, secretDigests: { "file-hb": HB_SECRET } }],
  ["missing digest", { ...snapshot, secretDigests: {} }],
  [
    "digest of a non-heartbeat",
    { ...snapshot, secretDigests: { "file-hb": HB_DIGEST, "file-web": HB_DIGEST } },
  ],
])("an unmaterialized snapshot is refused: %s", (_label, bad) => {
  expect(() => store.writeSnapshot(bad)).toThrow(CheckStoreError);
  const text = JSON.stringify(db.query("SELECT * FROM config_state").all());
  expect(text).not.toContain("keep");
  expect(text).not.toContain(HB_SECRET);
  expect(store.snapshot()).toBeNull();
});

test("stored definitions and snapshots keep literal headers, env names and bodies, digests only", () => {
  store.create(http("web"), null);
  store.create(heartbeat, HB_DIGEST);
  store.writeSnapshot(snapshot);
  const defs = JSON.stringify(
    db.query("SELECT check_json, secret_sha256 FROM check_definitions").all(),
  );
  const snap = JSON.stringify(db.query("SELECT file_snapshot_json FROM config_state").all());
  for (const text of [defs, snap]) {
    expect(text).toContain("lit-db-sentinel-1");
    expect(text).toContain("PULSE_HEADER_SENTINEL_DB_ENV");
    expect(text).toContain("body-db-sentinel-1");
    expect(text).toContain(HB_DIGEST);
    expect(text).not.toContain(HB_SECRET);
    expect(text).not.toContain("keep");
  }
});
