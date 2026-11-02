import type { TokenScope } from "@lorenzh/pulse-contract";

/** What a route needs from a token (D1). */
export type Permission =
  | "probe"
  | "config-read"
  | "config-write"
  | "incident-write"
  | "token-admin"
  | "audit-read";

/** True when a token with `scopes` may use a route that needs `permission`. */
export function canUse(scopes: readonly TokenScope[], permission: Permission): boolean {
  const has = (scope: TokenScope): boolean => scopes.includes(scope);
  switch (permission) {
    case "probe":
      return has("probe");
    case "config-read":
      return has("read") || has("checks");
    case "config-write":
      return has("admin") && has("checks");
    case "incident-write":
      return has("admin") && has("incidents");
    case "token-admin":
    case "audit-read":
      return has("admin");
    default: {
      const never: never = permission;
      return never;
    }
  }
}

/**
 * The grant rule: a caller may create, rotate or revoke a token only when it holds every scope
 * of that token. `probe` counts as `checks`, because `/probe/checks` serves check headers and bodies.
 */
export function canGrant(caller: readonly TokenScope[], target: readonly TokenScope[]): boolean {
  return target.every((scope) => caller.includes(scope === "probe" ? "checks" : scope));
}

/** The fields that decide whether a token is active. */
export interface TokenActivity {
  id: string;
  scopes: readonly TokenScope[];
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Not revoked, and `now` before its expiry (or no expiry). */
export function isActive(token: TokenActivity, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || now < token.expiresAt);
}

/** True when revoking `target` would leave no active token that holds `admin`. */
export function isLastActiveAdmin(
  target: TokenActivity,
  tokens: readonly TokenActivity[],
  now: number,
): boolean {
  if (!target.scopes.includes("admin") || !isActive(target, now)) return false;
  return !tokens.some((t) => t.id !== target.id && t.scopes.includes("admin") && isActive(t, now));
}
