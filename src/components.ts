import {
  aggregateUptime,
  type CheckState,
  type CheckUptime,
  type Component,
  type ComponentUptime,
  type ComponentWithState,
  combineStates,
  type Incident,
} from "@lorenzh/pulse-contract";

/** The combined state, window uptime and open incident ids of every component, in configured order. */
export function componentsWithState(
  components: readonly Component[],
  states: readonly { id: string; state: CheckState }[],
  uptime: readonly CheckUptime[],
  openIncidents: readonly Incident[],
): ComponentWithState[] {
  const stateOf = new Map(states.map((s) => [s.id, s.state]));
  const uptimes = componentsUptime(components, uptime);
  return components.map((component, i) => {
    const memberStates = component.checkIds.flatMap((id) => stateOf.get(id) ?? []);
    const incidentIds = openIncidents
      .filter((incident) => component.checkIds.includes(incident.checkId))
      .map((incident) => incident.id)
      .sort((a, b) => a - b);
    return {
      ...component,
      state: combineStates(memberStates),
      uptime: uptimes[i]?.uptime ?? null,
      incidentIds,
    };
  });
}

/** The 90-day uptime of every component, in configured order. */
export function componentsUptime(
  components: readonly Component[],
  uptime: readonly CheckUptime[],
): ComponentUptime[] {
  const daysOf = new Map(uptime.map((u) => [u.checkId, u.days]));
  return components.map((component) => {
    const members = component.checkIds.flatMap((id) => {
      const days = daysOf.get(id);
      return days === undefined ? [] : [days];
    });
    const { days, uptime: windowUptime } = aggregateUptime(members);
    return { componentId: component.id, days, uptime: windowUptime };
  });
}
