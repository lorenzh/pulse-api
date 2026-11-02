import { expect, test } from "bun:test";
import type { TokenScope } from "@lorenzh/pulse-contract";
import { canGrant, canUse, isLastActiveAdmin, type Permission } from "./token-scopes.ts";

const ALL: TokenScope[] = ["read", "checks", "incidents", "admin"];

test.each<[TokenScope[], Permission, boolean]>([
  [["read", "checks"], "config-write", false],
  [["read"], "config-write", false],
  [["admin"], "config-write", false],
  [["admin", "checks"], "config-write", true],
  [["admin", "checks"], "incident-write", false],
  [["admin", "incidents"], "incident-write", true],
  [["incidents"], "config-read", false],
  [["admin", "checks"], "config-read", true],
  [["read"], "config-read", true],
  [["probe"], "config-read", false],
  [["probe"], "audit-read", false],
  [["probe"], "probe", true],
  [ALL, "probe", false],
  [["admin"], "token-admin", true],
  [["read", "checks", "incidents"], "token-admin", false],
  [["admin"], "audit-read", true],
])("canUse(%p, %p) is %p", (scopes, permission, expected) => {
  expect(canUse(scopes, permission)).toBe(expected);
});

test("grant rule: a caller grants only scopes it holds, probe counts as checks", () => {
  expect(canGrant(["admin", "incidents"], ["checks"])).toBe(false);
  expect(canGrant(["admin", "incidents"], ["probe"])).toBe(false);
  expect(canGrant(["admin", "checks"], ALL)).toBe(false);
  expect(canGrant(["admin", "checks"], ["probe"])).toBe(true);
  expect(canGrant(ALL, ALL)).toBe(true);
});

const T = 1_800_000_000_000;
const admin = (
  id: string,
  over: { expiresAt?: number | null; revokedAt?: number | null } = {},
) => ({
  id,
  scopes: ALL,
  expiresAt: over.expiresAt ?? null,
  revokedAt: over.revokedAt ?? null,
});

test("last admin: the only active admin cannot be revoked; with two the first passes", () => {
  const a = admin("a");
  expect(isLastActiveAdmin(a, [a], T)).toBe(true);
  const b = admin("b");
  expect(isLastActiveAdmin(a, [a, b], T)).toBe(false);
  expect(isLastActiveAdmin(b, [{ ...a, revokedAt: T }, b], T)).toBe(true);
  expect(isLastActiveAdmin(a, [a, admin("c", { expiresAt: T })], T)).toBe(true);
  expect(isLastActiveAdmin(a, [a, admin("c", { expiresAt: T + 1 })], T)).toBe(false);
  const reader = { id: "r", scopes: ["read"] as TokenScope[], expiresAt: null, revokedAt: null };
  expect(isLastActiveAdmin(reader, [reader], T)).toBe(false);
});
