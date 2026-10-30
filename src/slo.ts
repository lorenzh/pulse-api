import { aggregateUptime, type Slo, type UptimeDay } from "@lorenzh/pulse-contract";

export const SLO_WINDOW_DAYS = 30;

/** Result-weighted availability in percent over the last 30 days of the members' day lists; null without results. */
export function windowAvailability(members: readonly (readonly UptimeDay[])[]): number | null {
  return aggregateUptime(members.map((days) => days.slice(-SLO_WINDOW_DAYS))).uptime;
}

/** The percent of the error budget left; negative when exceeded. */
export function budgetRemaining(target: number, availability: number): number {
  return 100 * (1 - (100 - availability) / (100 - target));
}

export function buildSlo(target: number, availability: number | null): Slo {
  return {
    target,
    windowDays: SLO_WINDOW_DAYS,
    availability,
    budgetRemaining: availability === null ? null : budgetRemaining(target, availability),
  };
}
