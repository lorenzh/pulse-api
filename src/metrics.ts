import type { CheckState, Location } from "@lorenzh/pulse-contract";
import { createRegistry, DURATION_BUCKETS_SECONDS } from "@lorenzh/pulse-kit";

const CHECK_STATES: readonly CheckState[] = ["up", "degraded", "down", "unknown", "maintenance"];

export const CONFIG_RELOAD_RESULTS = ["ok", "invalid"] as const;
export const CONFIG_WRITE_KINDS = ["check", "component", "maintenance"] as const;
export const CONFIG_WRITE_ACTIONS = ["create", "replace", "delete"] as const;
export const CONFIG_WRITE_RESULTS = [
  "ok",
  "invalid",
  "conflict",
  "stale",
  "readonly",
  "error",
] as const;
export type ConfigReloadResult = (typeof CONFIG_RELOAD_RESULTS)[number];
export type ConfigWriteKind = (typeof CONFIG_WRITE_KINDS)[number];
export type ConfigWriteAction = (typeof CONFIG_WRITE_ACTIONS)[number];
export type ConfigWriteResult = (typeof CONFIG_WRITE_RESULTS)[number];

export interface Metrics {
  recordResult(checkId: string, location: string, latencyMs: number): void;
  recordIncident(event: "opened" | "resolved"): void;
  recordManualIncident(event: "created" | "resolved"): void;
  recordRequest(route: string, code: number): void;
  /** Start both heartbeat counters of a check at 0, so they show before the first event. */
  trackHeartbeat(checkId: string): void;
  recordHeartbeatPing(checkId: string): void;
  /** Add `count` missed periods to a check. */
  recordHeartbeatMissed(checkId: string, count: number): void;
  recordConfigReload(result: ConfigReloadResult): void;
  recordConfigWrite(
    kind: ConfigWriteKind,
    action: ConfigWriteAction,
    result: ConfigWriteResult,
  ): void;
  /** Prometheus text exposition. Only check ids, locations, states and route patterns appear. */
  render(): string;
}

export interface MetricsDeps {
  /** The check states at scrape time. */
  listStates?: () => readonly { id: string; state: CheckState }[];
  /** The probe locations at scrape time. */
  listLocations?: () => readonly Location[];
  /** The error budget left, in percent, of every check and component that has an availability target and results. */
  listBudgets?: () => {
    checks: readonly { id: string; budgetRemaining: number }[];
    components: readonly { id: string; budgetRemaining: number }[];
  };
}

/** Counters live in memory and reset on restart; check states are read at every scrape. */
export function createMetrics({
  listStates = () => [],
  listLocations = () => [],
  listBudgets = () => ({ checks: [], components: [] }),
}: MetricsDeps = {}): Metrics {
  const registry = createRegistry();
  const up = registry.gauge("pulse_up", "Whether the API is running.");
  const checkState = registry.gauge(
    "pulse_api_check_state",
    "Current state of a check: 1 for its state, 0 for the others.",
  );
  const locationLastResult = registry.gauge(
    "pulse_api_location_last_result_timestamp_seconds",
    "Newest accepted result timestamp of a probe location, in Unix seconds.",
  );
  const budgetRemaining = registry.gauge(
    "pulse_api_slo_budget_remaining_ratio",
    "Error budget left of the 30-day availability target, as a ratio (0.5 is 50 %, negative when exceeded).",
  );
  const ingested = registry.counter(
    "pulse_api_results_ingested_total",
    "Results accepted, by probe location.",
  );
  const latency = registry.histogram(
    "pulse_api_result_latency_seconds",
    "Latency of accepted results, by check.",
    DURATION_BUCKETS_SECONDS,
  );
  const opened = registry.counter("pulse_api_incidents_opened_total", "Incidents opened.");
  const resolved = registry.counter("pulse_api_incidents_resolved_total", "Incidents resolved.");
  const manualCreated = registry.counter(
    "pulse_api_manual_incidents_created_total",
    "Manual incidents created.",
  );
  const manualResolved = registry.counter(
    "pulse_api_manual_incidents_resolved_total",
    "Manual incidents resolved.",
  );
  const requests = registry.counter(
    "pulse_api_http_requests_total",
    "HTTP requests, by route pattern and status code.",
  );
  const heartbeatPings = registry.counter("pulse_heartbeat_pings_total", "Heartbeat pings.");
  const heartbeatMissed = registry.counter(
    "pulse_heartbeat_missed_total",
    "Missed heartbeat periods.",
  );
  const configReloads = registry.counter(
    "pulse_api_config_reload_total",
    "Reloads of the checks file, by result.",
  );
  const configWrites = registry.counter(
    "pulse_api_config_writes_total",
    "Admin writes to the checks file, by kind, action and result.",
  );
  for (const result of CONFIG_RELOAD_RESULTS) configReloads.inc({ result }, 0);
  for (const kind of CONFIG_WRITE_KINDS) {
    for (const action of CONFIG_WRITE_ACTIONS) {
      for (const result of CONFIG_WRITE_RESULTS) configWrites.inc({ kind, action, result }, 0);
    }
  }
  up.set(1);
  opened.inc({}, 0);
  resolved.inc({}, 0);
  manualCreated.inc({}, 0);
  manualResolved.inc({}, 0);

  registry.collect(() => {
    checkState.remove({});
    for (const { id, state } of listStates()) {
      for (const s of CHECK_STATES) checkState.set(s === state ? 1 : 0, { check: id, state: s });
    }
    locationLastResult.remove({});
    for (const { name, lastResultAt } of listLocations()) {
      locationLastResult.set(lastResultAt / 1000, { location: name });
    }
    budgetRemaining.remove({});
    const budgets = listBudgets();
    for (const { id, budgetRemaining: percent } of budgets.checks) {
      budgetRemaining.set(percent / 100, { check: id });
    }
    for (const { id, budgetRemaining: percent } of budgets.components) {
      budgetRemaining.set(percent / 100, { component: id });
    }
  });

  return {
    recordResult(checkId, location, latencyMs) {
      ingested.inc({ location });
      latency.observe(latencyMs / 1000, { check: checkId });
    },
    recordIncident(event) {
      (event === "opened" ? opened : resolved).inc();
    },
    recordManualIncident(event) {
      (event === "created" ? manualCreated : manualResolved).inc();
    },
    recordRequest(route, code) {
      requests.inc({ route, code: String(code) });
    },
    trackHeartbeat(checkId) {
      heartbeatPings.inc({ check: checkId }, 0);
      heartbeatMissed.inc({ check: checkId }, 0);
    },
    recordHeartbeatPing(checkId) {
      heartbeatPings.inc({ check: checkId });
    },
    recordHeartbeatMissed(checkId, count) {
      heartbeatMissed.inc({ check: checkId }, count);
    },
    recordConfigReload(result) {
      configReloads.inc({ result });
    },
    recordConfigWrite(kind, action, result) {
      configWrites.inc({ kind, action, result });
    },
    render: () => registry.render(),
  };
}
