import type { CheckState } from "@lorenzh/pulse-contract";
import { createRegistry, DURATION_BUCKETS_SECONDS } from "@lorenzh/pulse-kit";

const CHECK_STATES: readonly CheckState[] = ["up", "degraded", "down", "unknown", "maintenance"];

export interface Metrics {
  recordResult(checkId: string, location: string, latencyMs: number): void;
  recordIncident(event: "opened" | "resolved"): void;
  recordRequest(route: string, code: number): void;
  /** Start both heartbeat counters of a check at 0, so they show before the first event. */
  trackHeartbeat(checkId: string): void;
  recordHeartbeatPing(checkId: string): void;
  /** Add `count` missed periods to a check. */
  recordHeartbeatMissed(checkId: string, count: number): void;
  /** Prometheus text exposition. Only check ids, locations, states and route patterns appear. */
  render(): string;
}

export interface MetricsDeps {
  /** The check states at scrape time. */
  listStates?: () => readonly { id: string; state: CheckState }[];
}

/** Counters live in memory and reset on restart; check states are read at every scrape. */
export function createMetrics({ listStates = () => [] }: MetricsDeps = {}): Metrics {
  const registry = createRegistry();
  const up = registry.gauge("pulse_up", "Whether the API is running.");
  const checkState = registry.gauge(
    "pulse_api_check_state",
    "Current state of a check: 1 for its state, 0 for the others.",
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
  const requests = registry.counter(
    "pulse_api_http_requests_total",
    "HTTP requests, by route pattern and status code.",
  );
  const heartbeatPings = registry.counter("pulse_heartbeat_pings_total", "Heartbeat pings.");
  const heartbeatMissed = registry.counter(
    "pulse_heartbeat_missed_total",
    "Missed heartbeat periods.",
  );
  up.set(1);
  opened.inc({}, 0);
  resolved.inc({}, 0);

  registry.collect(() => {
    checkState.remove({});
    for (const { id, state } of listStates()) {
      for (const s of CHECK_STATES) checkState.set(s === state ? 1 : 0, { check: id, state: s });
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
    render: () => registry.render(),
  };
}
