import type { Metrics } from "./metrics.ts";
import { HEARTBEAT_LOCATION, type Service } from "./service.ts";

export interface HeartbeatDeps {
  service: Pick<Service, "listHeartbeats" | "ingest">;
  metrics: Pick<Metrics, "trackHeartbeat" | "recordHeartbeatMissed">;
  now: () => number;
}

/** In-memory view of one check: when we started to wait and how many missed periods we counted. */
interface Watch {
  period: number;
  grace: number;
  startedAt: number;
  /** The reference time of the count below; a new ping or restart resets the count. */
  base: number;
  missed: number;
}

export const HEARTBEAT_TICK_MS = 1000;

/**
 * Judges every active heartbeat check. A check is overdue when more than `period + grace` passed
 * since the later of its last ping and `startedAt`. `startedAt` is the start of the evaluator for
 * checks present at the first tick, otherwise the time the check or its period or grace was first
 * seen, so the downtime of the api never opens an incident.
 */
export function createHeartbeatEvaluator({ service, metrics, now }: HeartbeatDeps): {
  tick(): void;
} {
  const watches = new Map<string, Watch>();
  const startedAt = now();
  let isFirstTick = true;
  return {
    tick() {
      const t = now();
      // Checks present at the first tick wait from the start of the evaluator, not from the tick.
      const since = isFirstTick ? startedAt : t;
      isFirstTick = false;
      const active = service.listHeartbeats();
      const ids = new Set(active.map((h) => h.id));
      for (const id of watches.keys()) if (!ids.has(id)) watches.delete(id);
      for (const h of active) {
        let w = watches.get(h.id);
        if (w === undefined || w.period !== h.period || w.grace !== h.grace) {
          metrics.trackHeartbeat(h.id);
          w = { period: h.period, grace: h.grace, startedAt: since, base: since, missed: 0 };
          watches.set(h.id, w);
        }
        const base = Math.max(h.lastPingAt ?? Number.NEGATIVE_INFINITY, w.startedAt);
        if (base !== w.base) {
          w.base = base;
          w.missed = 0;
        }
        const late = t - base - (h.period + h.grace);
        if (late <= 0) continue;
        const missed = 1 + Math.floor(late / h.period);
        if (missed > w.missed) {
          metrics.recordHeartbeatMissed(h.id, missed - w.missed);
          w.missed = missed;
        }
        if (h.state === "down" || h.isInMaintenance) continue;
        service.ingest(
          {
            checkId: h.id,
            timestamp: t,
            status: "down",
            statusCode: null,
            latencyMs: 0,
            reason: `no ping within ${h.period + h.grace}ms`,
            location: HEARTBEAT_LOCATION,
            attempts: 1,
          },
          true,
        );
      }
    },
  };
}

export interface HeartbeatTimerDeps {
  evaluator: { tick(): void };
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (message: string) => void;
}

/** Tick every second. The next tick is scheduled after one ends, so ticks never overlap. */
export function startHeartbeatEvaluator(deps: HeartbeatTimerDeps): { stop(): void } {
  let stopped = false;
  let handle: unknown;
  const run = (): void => {
    try {
      deps.evaluator.tick();
    } catch (err) {
      deps.log(
        `heartbeat evaluation failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!stopped) handle = deps.setTimeout(run, HEARTBEAT_TICK_MS);
  };
  handle = deps.setTimeout(run, HEARTBEAT_TICK_MS);
  return {
    stop() {
      stopped = true;
      if (handle !== undefined) deps.clearTimeout(handle);
    },
  };
}
