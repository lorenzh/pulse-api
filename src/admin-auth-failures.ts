import type { Metrics } from "./metrics.ts";
import { canUse, type Permission } from "./token-scopes.ts";
import type { AuthenticatedToken, TokenStore } from "./token-store.ts";
import { bearerSecret } from "./tokens.ts";

/**
 * Why an admin-side authentication failed (D2): no Bearer header, a credential nobody knows, an
 * expired, revoked or retired one, a probe token, or an admin-side token without the scope.
 */
export type AdminAuthTokenKind = "missing" | "unknown" | "inactive" | "probe" | "scope";

export type AdminAccess =
  | { kind: "ok"; token: AuthenticatedToken }
  | { kind: "denied"; status: 401 | 403; token: AdminAuthTokenKind };

/** Authenticate `header` for an admin-side route that needs `permission`. */
export function adminAccess(
  store: Pick<TokenStore, "authenticate">,
  header: string | undefined,
  permission: Permission,
): AdminAccess {
  const secret = bearerSecret(header);
  if (secret === undefined) return { kind: "denied", status: 401, token: "missing" };
  const auth = store.authenticate(secret);
  if (auth.kind !== "ok") return { kind: "denied", status: 401, token: auth.kind };
  if (auth.token.scopes.includes("probe")) return { kind: "denied", status: 403, token: "probe" };
  if (!canUse(auth.token.scopes, permission)) {
    return { kind: "denied", status: 403, token: "scope" };
  }
  return { kind: "ok", token: auth.token };
}

/** One log line per key and window; the other failures are only counted. */
export const ADMIN_AUTH_LOG_WINDOW_MS = 60_000;

export interface AdminAuthFailures {
  /** Count a failed admin authentication; `route` must be a route pattern, never a raw path. */
  record(route: string, status: 401 | 403, token: AdminAuthTokenKind): void;
}

export interface AdminAuthFailuresDeps {
  now: () => number;
  warn: (message: string, fields: Record<string, string>) => void;
  metrics: Pick<Metrics, "recordAdminAuthFailure">;
}

/**
 * Count every failure and log at most one line per (route, status, token) key and window. The
 * line carries the number of failures dropped for its key since that key's previous line. Keys are
 * route patterns, so the map stays small (at most 12 routes x 2 statuses x 5 kinds).
 */
export function createAdminAuthFailures(deps: AdminAuthFailuresDeps): AdminAuthFailures {
  const keys = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  return {
    record(route, status, token) {
      deps.metrics.recordAdminAuthFailure(route, status);
      const key = `${route} ${status} ${token}`;
      const now = deps.now();
      const state = keys.get(key);
      if (state !== undefined && now - state.lastLoggedAt < ADMIN_AUTH_LOG_WINDOW_MS) {
        state.suppressed += 1;
        return;
      }
      // No token value, digest, length or header value goes into the line.
      deps.warn("admin auth failed", {
        route,
        status: String(status),
        token,
        suppressed: String(state?.suppressed ?? 0),
      });
      keys.set(key, { lastLoggedAt: now, suppressed: 0 });
    },
  };
}
