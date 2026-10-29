import type { CheckState } from "@lorenzh/pulse-contract";

/** Histogram bucket bounds in seconds. */
export const LATENCY_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const CHECK_STATES: readonly CheckState[] = ["up", "degraded", "down", "unknown", "maintenance"];

export interface Histogram {
  /** Cumulative count per bucket, then the total in the last slot. */
  buckets: number[];
  sum: number;
}

export interface Metrics {
  recordResult(checkId: string, location: string, latencyMs: number): void;
  recordIncident(event: "opened" | "resolved"): void;
  recordRequest(route: string, code: number): void;
  /** Prometheus text exposition. Only check ids, locations, states and route patterns appear. */
  render(states: readonly { id: string; state: CheckState }[]): string;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function labels(pairs: Record<string, string | number>): string {
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
    .join(",");
  return `{${body}}`;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Counters live in memory and reset on restart. */
export function createMetrics(): Metrics {
  const ingested = new Map<string, number>();
  const histograms = new Map<string, Histogram>();
  const requests = new Map<string, number>();
  const incidents = { opened: 0, resolved: 0 };

  return {
    recordResult(checkId, location, latencyMs) {
      bump(ingested, location);
      const seconds = latencyMs / 1000;
      let h = histograms.get(checkId);
      if (h === undefined) {
        h = { buckets: new Array<number>(LATENCY_BUCKETS_SECONDS.length + 1).fill(0), sum: 0 };
        histograms.set(checkId, h);
      }
      LATENCY_BUCKETS_SECONDS.forEach((bound, i) => {
        if (seconds <= bound) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
      });
      h.buckets[LATENCY_BUCKETS_SECONDS.length] =
        (h.buckets[LATENCY_BUCKETS_SECONDS.length] ?? 0) + 1;
      h.sum += seconds;
    },

    recordIncident(event) {
      incidents[event] += 1;
    },

    recordRequest(route, code) {
      bump(requests, JSON.stringify([route, code]));
    },

    render(states) {
      const out: string[] = [];
      out.push("# TYPE pulse_up gauge", "pulse_up 1");

      out.push("# TYPE pulse_api_check_state gauge");
      for (const { id, state } of states) {
        for (const s of CHECK_STATES) {
          out.push(
            `pulse_api_check_state${labels({ check: id, state: s })} ${s === state ? 1 : 0}`,
          );
        }
      }

      out.push("# TYPE pulse_api_results_ingested_total counter");
      for (const [location, n] of ingested) {
        out.push(`pulse_api_results_ingested_total${labels({ location })} ${n}`);
      }

      out.push("# TYPE pulse_api_result_latency_seconds histogram");
      for (const [check, h] of histograms) {
        LATENCY_BUCKETS_SECONDS.forEach((bound, i) => {
          out.push(
            `pulse_api_result_latency_seconds_bucket${labels({ check, le: bound })} ${h.buckets[i]}`,
          );
        });
        const total = h.buckets[LATENCY_BUCKETS_SECONDS.length];
        out.push(
          `pulse_api_result_latency_seconds_bucket${labels({ check, le: "+Inf" })} ${total}`,
        );
        out.push(`pulse_api_result_latency_seconds_sum${labels({ check })} ${h.sum}`);
        out.push(`pulse_api_result_latency_seconds_count${labels({ check })} ${total}`);
      }

      out.push(
        "# TYPE pulse_api_incidents_opened_total counter",
        `pulse_api_incidents_opened_total ${incidents.opened}`,
        "# TYPE pulse_api_incidents_resolved_total counter",
        `pulse_api_incidents_resolved_total ${incidents.resolved}`,
      );

      out.push("# TYPE pulse_api_http_requests_total counter");
      for (const [key, n] of requests) {
        const [route, code] = JSON.parse(key) as [string, number];
        out.push(`pulse_api_http_requests_total${labels({ route, code })} ${n}`);
      }
      return `${out.join("\n")}\n`;
    },
  };
}
