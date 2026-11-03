import { clientKeyOf, createFailureLimiter, type FailureLimiter } from "@lorenzh/pulse-kit";
import {
  ADMIN_AUTH_LOG_WINDOW_MS,
  type AdminAuthFailures,
  adminAccess,
} from "./admin-auth-failures.ts";
import type { Metrics } from "./metrics.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken, TokenStore } from "./token-store.ts";

/** Failures per client and window before the auth point answers 429. */
export const ADMIN_AUTH_FAILURE_LIMIT = 10;
/** A fixed window that starts at the client's first failure. */
export const ADMIN_AUTH_WINDOW_MS = 60_000;
/** Clients with their own window; the others share one overflow budget. */
export const ADMIN_AUTH_MAX_CLIENTS = 10_000;

export type AdminAuthDecision =
  | { kind: "ok"; token: AuthenticatedToken }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "throttled"; retryAfterSeconds: number };

export interface AdminAuthRequest {
  /** The socket peer address; forwarding headers are never used. */
  remoteAddress: string | undefined;
  authorization: string | undefined;
  /** A route pattern, never a raw path. */
  route: string;
  permission: Permission;
}

export interface AdminAuthThrottle {
  /**
   * Check the client's budget, authenticate, then count a denial. Synchronous on purpose: an
   * `await` between the check and the record would let a burst past the limit.
   */
  authorize(request: AdminAuthRequest): AdminAuthDecision;
}

export interface AdminAuthThrottleDeps {
  tokens: Pick<TokenStore, "authenticate">;
  authFailures: AdminAuthFailures;
  now: () => number;
  warn: (message: string, fields: Record<string, string>) => void;
  metrics: Pick<Metrics, "recordAdminAuthThrottled">;
  /** Defaults to a limiter with the policy constants above. */
  limiter?: FailureLimiter;
}

export function createAdminAuthThrottle(deps: AdminAuthThrottleDeps): AdminAuthThrottle {
  const limiter =
    deps.limiter ??
    createFailureLimiter({
      limit: ADMIN_AUTH_FAILURE_LIMIT,
      windowMs: ADMIN_AUTH_WINDOW_MS,
      maxKeys: ADMIN_AUTH_MAX_CLIENTS,
      now: deps.now,
    });
  // Keyed by route pattern, so the map stays small.
  const logged = new Map<string, { lastLoggedAt: number; suppressed: number }>();

  const noteThrottled = (route: string): void => {
    deps.metrics.recordAdminAuthThrottled(route);
    const now = deps.now();
    const state = logged.get(route);
    if (state !== undefined && now - state.lastLoggedAt < ADMIN_AUTH_LOG_WINDOW_MS) {
      state.suppressed += 1;
      return;
    }
    // No client address, header, token value, digest or length goes into the line.
    deps.warn("admin auth throttled", {
      route,
      suppressed: String(state?.suppressed ?? 0),
    });
    logged.set(route, { lastLoggedAt: now, suppressed: 0 });
  };

  return {
    authorize(request) {
      const key = clientKeyOf(request.remoteAddress);
      const check = limiter.check(key);
      if (check.isBlocked) {
        noteThrottled(request.route);
        const seconds = Math.ceil(check.retryAfterMs / 1000);
        return {
          kind: "throttled",
          retryAfterSeconds: Math.min(Math.max(seconds, 1), ADMIN_AUTH_WINDOW_MS / 1000),
        };
      }
      const access = adminAccess(deps.tokens, request.authorization, request.permission);
      if (access.kind === "ok") return access;
      limiter.recordFailure(key);
      deps.authFailures.record(request.route, access.status, access.token);
      return { kind: "denied", status: access.status };
    },
  };
}
