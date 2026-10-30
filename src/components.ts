import {
  aggregateUptime,
  type CheckState,
  type CheckUptime,
  type Component,
  type ComponentUptime,
  type ComponentWithState,
  combineStates,
  type Incident,
  type UptimeDay,
} from "@lorenzh/pulse-contract";
import { buildSlo, windowAvailability } from "./slo.ts";

/** The combined state, window uptime and open incident ids of every component, in configured order. */
export function componentsWithState(
  components: readonly Component[],
  states: readonly { id: string; state: CheckState }[],
  uptime: readonly CheckUptime[],
  openIncidents: readonly Incident[],
  sloDays: (checkId: string) => readonly UptimeDay[],
): ComponentWithState[] {
  const stateOf = new Map(states.map((s) => [s.id, s.state]));
  const uptimes = componentsUptime(components, uptime);
  return components.map((component, i) => {
    const memberStates = component.checkIds.flatMap((id) => stateOf.get(id) ?? []);
    const incidentIds = openIncidents
      .filter((incident) => component.checkIds.includes(incident.checkId))
      .map((incident) => incident.id)
      .sort((a, b) => a - b);
    const withState: ComponentWithState = {
      ...component,
      state: combineStates(memberStates),
      uptime: uptimes[i]?.uptime ?? null,
      incidentIds,
    };
    if (component.availabilityTarget !== undefined) {
      withState.slo = buildSlo(
        component.availabilityTarget,
        windowAvailability(component.checkIds.map(sloDays)),
      );
    }
    return withState;
  });
}

function memberDays(component: Component, uptime: readonly CheckUptime[]): UptimeDay[][] {
  const daysOf = new Map(uptime.map((u) => [u.checkId, u.days]));
  return component.checkIds.flatMap((id) => {
    const days = daysOf.get(id);
    return days === undefined ? [] : [days];
  });
}

/** The error budget left, in percent, of every component with a target and results. */
export function componentBudgets(
  components: readonly Component[],
  sloDays: (checkId: string) => readonly UptimeDay[],
): { id: string; budgetRemaining: number }[] {
  return components.flatMap((component) => {
    if (component.availabilityTarget === undefined) return [];
    const { budgetRemaining } = buildSlo(
      component.availabilityTarget,
      windowAvailability(component.checkIds.map(sloDays)),
    );
    return budgetRemaining === null ? [] : [{ id: component.id, budgetRemaining }];
  });
}

/** The 90-day uptime of every component, in configured order. */
export function componentsUptime(
  components: readonly Component[],
  uptime: readonly CheckUptime[],
): ComponentUptime[] {
  return components.map((component) => {
    const { days, uptime: windowUptime } = aggregateUptime(memberDays(component, uptime));
    return { componentId: component.id, days, uptime: windowUptime };
  });
}
