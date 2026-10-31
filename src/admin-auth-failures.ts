import type { Metrics } from "./metrics.ts";
import { isBearer } from "./tokens.ts";

/** What the caller presented: no Bearer header, a token nobody knows, or a probe token. */
export type AdminAuthTokenKind = "missing" | "unknown" | "probe";

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

/** The kind of a header that failed the admin lookup. Never reads more than the header form. */
export function tokenKindOf(
  header: string | undefined,
  isProbeToken: (header: string | undefined) => boolean,
): AdminAuthTokenKind {
  if (!isBearer(header)) return "missing";
  return isProbeToken(header) ? "probe" : "unknown";
}

/**
 * Count every failure and log at most one line per (route, status, token) key and window. The
 * line carries the number of failures dropped for its key since that key's previous line. Keys are
 * route patterns, so the map stays small (at most 12 routes x 2 statuses x 3 kinds).
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
