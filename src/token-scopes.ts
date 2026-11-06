import type { TokenScope } from "@lorenzh/pulse-contract";

/** What a route needs from a token (D1). */
export type Permission =
  | "probe"
  | "config-read"
  | "config-write"
  | "incident-write"
  | "token-admin"
  | "audit-read"
  | "runtime-admin"
  | "status-service"
  | "notify-service";

/** The permissions of `/service/*`: a token whose only scope is the service's own. */
export type ServicePermission = Extract<Permission, "status-service" | "notify-service">;

/** True for a permission of a `/service/*` route. */
export function isServicePermission(permission: Permission): permission is ServicePermission {
  return permission === "status-service" || permission === "notify-service";
}

/** True for a token of a service: `probe`, `status` or `notify` (each is a sole scope). */
export function isServiceToken(scopes: readonly TokenScope[]): boolean {
  return scopes.some((s) => s === "probe" || s === "status" || s === "notify");
}

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
    case "runtime-admin":
      return has("admin");
    case "status-service":
      return scopes.length === 1 && has("status");
    case "notify-service":
      return scopes.length === 1 && has("notify");
    default: {
      const never: never = permission;
      return never;
    }
  }
}

/**
 * The grant rule: a caller may create, rotate or revoke a token only when it holds every scope
 * of that token. `probe` counts as `checks`, because `/probe/checks` serves check headers and bodies.
 * `status` and `notify` count as `admin`, because their tokens read runtime settings.
 */
export function canGrant(caller: readonly TokenScope[], target: readonly TokenScope[]): boolean {
  return target.every((scope) => caller.includes(grantScopeOf(scope)));
}

function grantScopeOf(scope: TokenScope): TokenScope {
  if (scope === "probe") return "checks";
  return scope === "status" || scope === "notify" ? "admin" : scope;
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
