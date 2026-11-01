import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRecord } from "./audit-log.ts";
import { openDb } from "./db.ts";
import { canUse, type Permission } from "./token-scopes.ts";
import {
  type Actor,
  createTokenStore,
  generateSecret,
  generateTokenId,
  type NewToken,
  type TokenStore,
  TokenStoreError,
} from "./token-store.ts";

const T = 1_800_000_000_000;
const ACTOR: Actor = { tokenId: null, name: "test" };
const ADMIN: NewToken = {
  name: "ops",
  scopes: ["read", "checks", "incidents", "admin"],
  location: null,
  expiresAt: null,
  source: "api",
};

let dir: string;
let file: string;
let db: Database;
let clock: number;
let seq: number;
let recorded: AuditRecord[];
beforeEach(() => {
  seq = 0;
  recorded = [];
  dir = mkdtempSync(join(tmpdir(), "pulse-tokens-"));
  file = join(dir, "pulse.db");
  db = openDb(file);
  clock = T;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(
  over: { recordAudit?: (e: AuditRecord) => void; database?: Database } = {},
): TokenStore {
  const database = over.database ?? db;
  return createTokenStore({
    db: database,
    now: () => clock,
    generateSecret: () => `pulse_${String(++seq).padStart(43, "s")}`,
    generateId: () => `tok_${String(++seq).padStart(24, "0")}`,
    recordAudit:
      over.recordAudit ??
      ((e) => {
        recorded.push(e);
      }),
  });
}

const ok = (s: TokenStore, secret: string): boolean => s.authenticate(secret).kind === "ok";

test("generated secret and id have the D4 format", () => {
  for (let i = 0; i < 20; i++) {
    const secret = generateSecret();
    expect(secret).toMatch(/^pulse_[A-Za-z0-9_-]{43}$/);
    expect(secret).toHaveLength(49);
    expect(generateTokenId()).toMatch(/^tok_[0-9a-f]{24}$/);
  }
});

test("create stores only the digest and authenticates the secret", () => {
  const real = createTokenStore({
    db,
    now: () => clock,
    generateSecret,
    generateId: generateTokenId,
    recordAudit: () => undefined,
  });
  const { token, secret } = real.create(ADMIN, ACTOR);
  expect(token.id).toMatch(/^tok_[0-9a-f]{24}$/);
  expect(secret).toMatch(/^pulse_[A-Za-z0-9_-]{43}$/);
  const row = db.query("SELECT secret_sha256 FROM token_secrets").get() as {
    secret_sha256: string;
  };
  expect(row.secret_sha256).toBe(createHash("sha256").update(secret).digest("hex"));
  for (const table of ["api_tokens", "token_secrets"]) {
    for (const r of db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
      expect(Object.values(r).map(String)).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  }
  expect(real.authenticate(secret)).toEqual({
    kind: "ok",
    token: { id: token.id, name: "ops", scopes: ADMIN.scopes.slice(), location: null },
  });
  expect(real.authenticate(`${secret}x`).kind).toBe("unknown");
  expect(Object.keys(real.get(token.id) ?? {})).not.toContain("secret");
});

test("rotation: overlap, restart, expiry cap, repeated rotate and revoke", () => {
  const s = store();
  const { token, secret: old } = s.create(ADMIN, ACTOR);
  s.create({ ...ADMIN, name: "spare" }, ACTOR);
  const rotated = s.rotate(token.id, ACTOR);
  const fresh = rotated.secret;
  expect(rotated.token.previousValidUntil).toBe(T + 600_000);
  expect(rotated.token.rotatedAt).toBe(T);

  clock = T + 1;
  expect(() => s.rotate(token.id, ACTOR)).toThrow("a rotation is still in its overlap");

  clock = T + 300_000;
  const reopened = store();
  clock = T + 599_999;
  for (const x of [s, reopened]) {
    expect(ok(x, old)).toBe(true);
    expect(ok(x, fresh)).toBe(true);
  }
  clock = T + 600_000;
  for (const x of [s, reopened]) {
    expect(x.authenticate(old).kind).toBe("inactive");
    expect(ok(x, fresh)).toBe(true);
  }
  expect(s.get(token.id)?.previousValidUntil).toBeNull();
  const again = s.rotate(token.id, ACTOR);
  expect(again.token.previousValidUntil).toBe(T + 1_200_000);
});

test("rotation: the new credential stops at the token's expiry", () => {
  const s = store();
  const { token, secret: old } = s.create({ ...ADMIN, expiresAt: T + 120_000 }, ACTOR);
  const { secret: fresh } = s.rotate(token.id, ACTOR);
  clock = T + 119_999;
  expect(ok(s, old) && ok(s, fresh)).toBe(true);
  clock = T + 120_000;
  expect(ok(s, old)).toBe(false);
  expect(ok(s, fresh)).toBe(false);
  expect(() => s.rotate(token.id, ACTOR)).toThrow("token is expired");
});

test("revoke during the overlap rejects both credentials at once", () => {
  const s = store();
  s.create({ ...ADMIN, name: "other" }, ACTOR);
  const { token, secret: old } = s.create(ADMIN, ACTOR);
  const { secret: fresh } = s.rotate(token.id, ACTOR);
  clock = T + 1;
  const revoked = s.revoke(token.id, ACTOR);
  expect(revoked.revokedAt).toBe(T + 1);
  expect(ok(s, old)).toBe(false);
  expect(ok(s, fresh)).toBe(false);
  expect(ok(store(), fresh)).toBe(false);
  expect(() => s.revoke(token.id, ACTOR)).toThrow("token is revoked");
  expect(() => s.rotate(token.id, ACTOR)).toThrow("token is revoked");
});

test("revoke commits the last-used value with the revocation, or nothing", () => {
  const s = store();
  s.create({ ...ADMIN, name: "other" }, ACTOR);
  const { token, secret: old } = s.create(ADMIN, ACTOR);
  const { secret: fresh } = s.rotate(token.id, ACTOR);
  clock = T + 10;
  expect(ok(s, fresh)).toBe(true);
  db.run(`CREATE TRIGGER no_last_used BEFORE UPDATE OF last_used_at ON api_tokens
    BEGIN SELECT RAISE(ABORT, 'last used refused'); END`);
  clock = T + 20;
  expect(() => s.revoke(token.id, ACTOR)).toThrow("last used refused");
  expect(s.get(token.id)?.revokedAt).toBeNull();
  expect(recorded.map((e) => e.action)).not.toContain("token.revoke");
  db.run("DROP TRIGGER no_last_used");
  expect(s.revoke(token.id, ACTOR).revokedAt).toBe(T + 20);
  expect([ok(s, old), ok(s, fresh)]).toEqual([false, false]);
  const row = db.query("SELECT last_used_at AS v FROM api_tokens WHERE id = ?").get(token.id);
  expect(row).toEqual({ v: T + 10 });
});

test("the scopes read back from the store grant the D1 permissions", () => {
  const s = store();
  const all: Permission[] = [
    "probe",
    "config-read",
    "config-write",
    "incident-write",
    "token-admin",
    "audit-read",
  ];
  const grants = (scopes: NewToken["scopes"]): Permission[] => {
    const { token } = s.create({ ...ADMIN, name: `n${seq}`, scopes }, ACTOR);
    const read = s.get(token.id)?.scopes ?? [];
    return all.filter((p) => canUse(read, p));
  };
  expect(grants(["probe"])).toEqual(["probe"]);
  expect(grants(["read"])).toEqual(["config-read"]);
  expect(grants(["admin", "checks"])).toEqual([
    "config-read",
    "config-write",
    "token-admin",
    "audit-read",
  ]);
  expect(grants(["incidents", "admin"])).toEqual(["incident-write", "token-admin", "audit-read"]);
});

test("last admin: the only admin stays, with two the second revoke is refused", () => {
  const s = store();
  const first = s.create(ADMIN, ACTOR);
  const refuse = (id: string): void => {
    try {
      s.revoke(id, ACTOR);
      throw new Error("revoke passed");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenStoreError);
      expect(err instanceof TokenStoreError && err.reason).toBe("last-admin");
    }
  };
  refuse(first.token.id);
  expect(ok(s, first.secret)).toBe(true);
  const second = s.create({ ...ADMIN, name: "two" }, ACTOR);
  expect(s.revoke(first.token.id, ACTOR).revokedAt).toBe(T);
  refuse(second.token.id);
  expect(() => s.revoke("tok_unknown", ACTOR)).toThrow("token not found");
});

test("last used: one persisted update per 60 s, failures never count, flush on close", () => {
  db.run("CREATE TABLE updates (value INTEGER)");
  db.run(
    "CREATE TRIGGER count_updates AFTER UPDATE OF last_used_at ON api_tokens BEGIN INSERT INTO updates VALUES (NEW.last_used_at); END",
  );
  const updates = (): number[] =>
    (db.query("SELECT value FROM updates").all() as { value: number }[]).map((r) => r.value);
  const s = store();
  const { token, secret } = s.create(ADMIN, ACTOR);
  expect(s.authenticate("pulse_wrong").kind).toBe("unknown");
  expect(s.get(token.id)?.lastUsedAt).toBeNull();

  s.authenticate(secret);
  clock = T + 59_999;
  s.authenticate(secret);
  expect(updates()).toEqual([T]);
  expect(s.get(token.id)?.lastUsedAt).toBe(T + 59_999);
  expect(s.list()[0]?.lastUsedAt).toBe(T + 59_999);

  clock = T + 60_000;
  s.authenticate(secret);
  expect(updates()).toEqual([T, T + 60_000]);

  clock = T + 60_001;
  s.authenticate(secret);
  s.authenticate("pulse_wrong");
  expect(s.get(token.id)?.lastUsedAt).toBe(T + 60_001);
  s.flush();
  expect(updates()).toEqual([T, T + 60_000, T + 60_001]);
  s.flush();
  expect(updates()).toHaveLength(3);
});

test("an audit recorder that throws rolls the token write back", () => {
  const good = store();
  const keep = good.create({ ...ADMIN, name: "keep" }, ACTOR);
  const victim = good.create(ADMIN, ACTOR);
  const failing = store({
    recordAudit: () => {
      throw new Error("audit down");
    },
  });
  const count = (sql: string): number => (db.query(sql).get() as { n: number }).n;
  expect(() => failing.create({ ...ADMIN, name: "x" }, ACTOR)).toThrow("audit down");
  expect(count("SELECT COUNT(*) AS n FROM api_tokens")).toBe(2);
  expect(count("SELECT COUNT(*) AS n FROM token_secrets")).toBe(2);
  expect(() => failing.rotate(victim.token.id, ACTOR)).toThrow("audit down");
  expect(count("SELECT COUNT(*) AS n FROM token_secrets")).toBe(2);
  expect(failing.get(victim.token.id)?.rotatedAt).toBeNull();
  expect(() => failing.revoke(victim.token.id, ACTOR)).toThrow("audit down");
  expect(failing.get(victim.token.id)?.revokedAt).toBeNull();
  expect(ok(failing, victim.secret)).toBe(true);
  expect(ok(failing, keep.secret)).toBe(true);
});

test("each token write records one audit entry with the actor and target", () => {
  const s = store();
  const actor: Actor = { tokenId: "tok_actor", name: "boss" };
  const { token } = s.create(ADMIN, actor);
  s.create(
    { ...ADMIN, name: "imported", source: "file", secret: "legacy-secret-0123456789" },
    actor,
  );
  s.rotate(token.id, actor);
  s.revoke(token.id, actor);
  expect(recorded.map((e) => e.action)).toEqual([
    "token.create",
    "token.import",
    "token.rotate",
    "token.revoke",
  ]);
  expect(recorded[3]).toMatchObject({ actor, target: { kind: "token", id: token.id } });
  expect(ok(s, "legacy-secret-0123456789")).toBe(true);
});

test("list orders by createdAt then id and includes revoked tokens", () => {
  const s = store();
  clock = T + 5;
  const late = s.create(ADMIN, ACTOR);
  clock = T;
  s.create({ ...ADMIN, name: "early" }, ACTOR);
  const probe = s.create(
    { name: "p", scopes: ["probe"], location: "eu", expiresAt: null, source: "api" },
    ACTOR,
  );
  s.revoke(probe.token.id, ACTOR);
  expect(s.list().map((t) => t.id)).toEqual([
    `tok_${"3".padStart(24, "0")}`,
    `tok_${"5".padStart(24, "0")}`,
    late.token.id,
  ]);
  expect(s.get(probe.token.id)?.revokedAt).toBe(T);
  expect(s.get(probe.token.id)?.location).toBe("eu");
  expect(s.get("tok_missing")).toBeNull();
});
