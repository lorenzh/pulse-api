import type { CheckState, CheckStatus } from "@lorenzh/pulse-contract";

export const DOWNS_TO_OPEN = 3;

export interface CheckStateSnapshot {
  state: CheckState;
  consecutiveDown: number;
  incidentOpen: boolean;
}

export type IncidentAction = "open" | "resolve" | "none";

export const INITIAL_STATE: CheckStateSnapshot = {
  state: "unknown",
  consecutiveDown: 0,
  incidentOpen: false,
};

/** Pure rule: next state and incident action after one result. */
export function applyResult(
  prev: CheckStateSnapshot,
  status: CheckStatus,
): { next: CheckStateSnapshot; action: IncidentAction } {
  if (status === "up" || status === "degraded") {
    return {
      next: { state: status, consecutiveDown: 0, incidentOpen: false },
      action: prev.incidentOpen ? "resolve" : "none",
    };
  }
  const consecutiveDown = prev.consecutiveDown + 1;
  const open = !prev.incidentOpen && consecutiveDown >= DOWNS_TO_OPEN;
  return {
    next: { state: "down", consecutiveDown, incidentOpen: prev.incidentOpen || open },
    action: open ? "open" : "none",
  };
}

/**
 * Pure quorum rule over the latest status of each reporting location.
 * One location decides alone; with two or more, the check is down iff at least two are down.
 * Otherwise it is degraded if any location is degraded, else up.
 */
export function quorumStatus(latest: CheckStatus[]): CheckStatus {
  const only = latest[0];
  if (latest.length === 1 && only !== undefined) return only;
  if (latest.filter((s) => s === "down").length >= 2) return "down";
  return latest.some((s) => s === "degraded") ? "degraded" : "up";
}
