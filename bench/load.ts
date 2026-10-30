// The fixed load. The constants are part of the benchmark: change them only with a new baseline.
import { percentile } from "./measure.ts";

export const SEED_CHECKS = 20;
export const SEED_DAYS = 30;
export const PROBE_LOCATIONS = 3;
export const POST_RATE = 30;
export const GET_CHECKS_RATE = 10;
export const GET_UPTIME_RATE = 1;
export const WARMUP_S = 20;
export const DURATION_S = 60;
export const IDLE_S = 30;
export const CHECK_INTERVAL_MS = 10_000;

export function checkIds(): string[] {
  return Array.from({ length: SEED_CHECKS }, (_, i) => `c${i}`);
}

export interface BenchToken {
  location: string;
  token: string;
}

/** Tokens of the simulated probes plus the one of the real probe container. */
export function benchTokens(): { simulated: BenchToken[]; real: BenchToken } {
  const simulated = Array.from({ length: PROBE_LOCATIONS }, (_, i) => ({
    location: `sim${i}`,
    token: `bench-token-sim${i}-0123456789abcdef0123456789abcdef`,
  }));
  return {
    simulated,
    real: { location: "real", token: "bench-token-real-0123456789abcdef0123456789abcdef" },
  };
}

export interface LoadResult {
  p95GetChecksMs: number;
  p95PostResultsMs: number;
  rps: number;
}

export interface LoadOptions {
  apiUrl: string;
  /** Called once when warm-up ends, right before the measured window starts. */
  onWindowStart: () => Promise<void>;
}

interface Stream {
  rate: number;
  sent: number;
  send: (index: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  samples: number[] | undefined,
): Promise<void> {
  const start = performance.now();
  const response = await fetch(url, init).catch((err: unknown) => {
    throw new Error(
      `${init.method ?? "GET"} ${url} after ${Math.round(performance.now() - start)} ms`,
      { cause: err },
    );
  });
  await response.arrayBuffer();
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${url}: status ${response.status}`);
  }
  samples?.push(performance.now() - start);
}

/** Run warm-up and the measured window. Open loop: requests start on a fixed schedule. */
export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const { simulated } = benchTokens();
  const ids = checkIds();
  const getSamples: number[] = [];
  const postSamples: number[] = [];
  let measuring = false;
  let failure: Error | undefined;
  const fail = (err: unknown): void => {
    failure ??= err instanceof Error ? err : new Error(String(err));
  };

  const streams: Stream[] = [
    {
      rate: POST_RATE,
      sent: 0,
      send: (i) => {
        const id = ids[i % ids.length];
        const probe = simulated[i % simulated.length];
        if (id === undefined || probe === undefined) throw new Error("empty load fixture");
        const body = JSON.stringify({
          checkId: id,
          timestamp: Date.now(),
          status: "up",
          statusCode: 200,
          latencyMs: 5,
          reason: null,
          attempts: 1,
        });
        return timed(
          `${options.apiUrl}/results`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${probe.token}`, "content-type": "application/json" },
            body,
          },
          204,
          measuring ? postSamples : undefined,
        );
      },
    },
    {
      rate: GET_CHECKS_RATE,
      sent: 0,
      send: () => timed(`${options.apiUrl}/checks`, {}, 200, measuring ? getSamples : undefined),
    },
    {
      rate: GET_UPTIME_RATE,
      sent: 0,
      send: () => timed(`${options.apiUrl}/uptime`, {}, 200, undefined),
    },
  ];

  const pending = new Set<Promise<void>>();
  const start = performance.now();
  let windowStart: number | undefined;
  const total = (WARMUP_S + DURATION_S) * 1000;
  for (;;) {
    const elapsed = performance.now() - start;
    if (elapsed >= total || failure !== undefined) break;
    if (windowStart === undefined && elapsed >= WARMUP_S * 1000) {
      await options.onWindowStart();
      measuring = true;
      windowStart = performance.now();
    }
    for (const stream of streams) {
      const due = Math.floor((elapsed * stream.rate) / 1000) + 1;
      while (stream.sent < due) {
        const request = stream.send(stream.sent).catch(fail);
        stream.sent += 1;
        pending.add(request);
        void request.finally(() => pending.delete(request));
      }
    }
    await sleep(5);
  }
  await Promise.all(pending);
  if (failure !== undefined) throw new Error("load failed", { cause: failure });
  if (windowStart === undefined) throw new Error("measured window never started");
  const seconds = (performance.now() - windowStart) / 1000;
  return {
    p95GetChecksMs: percentile(getSamples, 0.95),
    p95PostResultsMs: percentile(postSamples, 0.95),
    rps: (getSamples.length + postSamples.length) / seconds,
  };
}
