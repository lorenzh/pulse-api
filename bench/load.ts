// The fixed load. The constants are part of the benchmark: change them only with a new baseline.
import { percentile } from "./measure.ts";

export const SEED_CHECKS = 20;
export const SEED_DAYS = 30;
export const PROBE_LOCATIONS = 3;
export const POST_RATE = 30;
export const GET_CHECKS_RATE = 10;
export const GET_UPTIME_RATE = 1;
export const GET_LATENCY_RATE = 1;
export const GET_CHECK_LATENCY_RATE = 1;
/** Availability objective of every bench check, so `GET /checks` builds an `slo` for each. */
export const AVAILABILITY_TARGET = 99.5;
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

/**
 * GET routes newer than the oldest api the bench compares against, by their name in the route
 * table of `src/server.ts`, with the metric each one feeds. Add a new measured route here.
 */
export const OPTIONAL_ROUTES = {
  "/latency": "p95_get_latency_ms",
  "/checks/:id/latency": "p95_get_check_latency_ms",
} as const;
export type OptionalRoute = keyof typeof OPTIONAL_ROUTES;

/** The optional routes absent from an api's route table, given the text of its `src/server.ts`. */
export function routesMissingFrom(serverSource: string): OptionalRoute[] {
  return (Object.keys(OPTIONAL_ROUTES) as OptionalRoute[]).filter(
    (route) => !serverSource.includes(`"${route}"`),
  );
}

/** A p95 is null when the api lacks its route (`LoadOptions.missingRoutes`). */
export interface LoadResult {
  p95GetChecksMs: number;
  p95PostResultsMs: number;
  p95GetLatencyMs: number | null;
  p95GetCheckLatencyMs: number | null;
  /** Requests of all five streams that finished in the measured window, per second. */
  rps: number;
  /** GETs sent again after the connection closed before any response. */
  retriedGets: number;
  /** POSTs lost the same way; never sent again: an api from before the unique result key stores a repeat twice. */
  droppedPosts: number;
}

/** More closed connections than this in one run fail it: then it is not the keep-alive race. */
export const MAX_CONNECTION_RESETS = 5;

export interface LoadOptions {
  apiUrl: string;
  /** Called once when warm-up ends, right before the measured window starts. */
  onWindowStart: () => Promise<void>;
  /** Routes the api does not have (from its source): not requested, their p95 is null. */
  missingRoutes?: readonly OptionalRoute[];
}

interface Stream {
  rate: number;
  sent: number;
  send: (index: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for a connection the server closed before it sent any response. Bun reuses a pooled
 * keep-alive connection that the api closes at its idle timeout at the same moment.
 */
export function isClosedBeforeResponse(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === "ECONNRESET" ||
    (typeof e?.message === "string" && e.message.includes("socket connection was closed"))
  );
}

export interface Resets {
  retriedGets: number;
  droppedPosts: number;
}

export async function timed(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  samples: number[] | undefined,
  resets: Resets,
): Promise<void> {
  const method = init.method ?? "GET";
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const wrap = (cause: unknown): Error =>
      new Error(`${method} ${url} after ${Math.round(performance.now() - start)} ms`, { cause });
    if (!isClosedBeforeResponse(err)) throw wrap(err);
    // One line per reset, so a failed run shows which route and how fast the close came.
    console.log(`[bench] closed before a response: ${wrap(err).message}`);
    if (method !== "GET") {
      resets.droppedPosts += 1;
      return;
    }
    resets.retriedGets += 1;
    response = await fetch(url, init).catch((retryErr: unknown) => {
      throw wrap(retryErr);
    });
  }
  await response.arrayBuffer();
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${url}: status ${response.status}`);
  }
  samples?.push(performance.now() - start);
}

/** Throw when the run has seen more closed-before-response connections than the cap allows. */
export function checkResets(resets: Resets): void {
  if (resets.retriedGets + resets.droppedPosts > MAX_CONNECTION_RESETS) {
    throw new Error(`more than ${MAX_CONNECTION_RESETS} connections closed before a response`);
  }
}

/** Wait for the requests still open, then apply the cap: resets can arrive during the drain. */
export async function drain(pending: Iterable<Promise<void>>, resets: Resets): Promise<void> {
  await Promise.all(pending);
  checkResets(resets);
}

function rateIfPresent(
  missing: readonly OptionalRoute[] | undefined,
  route: OptionalRoute,
  rate: number,
): number {
  return missing?.includes(route) ? 0 : rate;
}

function p95IfSent(rate: number, samples: number[]): number | null {
  return rate === 0 ? null : percentile(samples, 0.95);
}

/** Run warm-up and the measured window. Open loop: requests start on a fixed schedule. */
export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const { simulated } = benchTokens();
  const ids = checkIds();
  const getSamples: number[] = [];
  const postSamples: number[] = [];
  const uptimeSamples: number[] = [];
  const latencySamples: number[] = [];
  const checkLatencySamples: number[] = [];
  let measuring = false;
  let failure: Error | undefined;
  const resets: Resets = { retriedGets: 0, droppedPosts: 0 };
  const fail = (err: unknown): void => {
    failure ??= err instanceof Error ? err : new Error(String(err));
  };

  const latencyRate = rateIfPresent(options.missingRoutes, "/latency", GET_LATENCY_RATE);
  const checkLatencyRate = rateIfPresent(
    options.missingRoutes,
    "/checks/:id/latency",
    GET_CHECK_LATENCY_RATE,
  );
  const allStreams: Stream[] = [
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
          resets,
        );
      },
    },
    {
      rate: GET_CHECKS_RATE,
      sent: 0,
      send: () =>
        timed(`${options.apiUrl}/checks`, {}, 200, measuring ? getSamples : undefined, resets),
    },
    {
      rate: GET_UPTIME_RATE,
      sent: 0,
      send: () =>
        timed(`${options.apiUrl}/uptime`, {}, 200, measuring ? uptimeSamples : undefined, resets),
    },
    {
      rate: latencyRate,
      sent: 0,
      send: () =>
        timed(`${options.apiUrl}/latency`, {}, 200, measuring ? latencySamples : undefined, resets),
    },
    {
      rate: checkLatencyRate,
      sent: 0,
      send: (i) =>
        timed(
          `${options.apiUrl}/checks/${ids[i % ids.length]}/latency`,
          {},
          200,
          measuring ? checkLatencySamples : undefined,
          resets,
        ),
    },
  ];
  // A stream of a route the api lacks never starts.
  const streams = allStreams.filter((stream) => stream.rate > 0);

  const pending = new Set<Promise<void>>();
  const start = performance.now();
  let windowStart: number | undefined;
  const total = (WARMUP_S + DURATION_S) * 1000;
  for (;;) {
    const elapsed = performance.now() - start;
    try {
      checkResets(resets);
    } catch (err) {
      fail(err);
    }
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
  await drain(pending, resets).catch(fail);
  if (failure !== undefined) throw new Error("load failed", { cause: failure });
  if (windowStart === undefined) throw new Error("measured window never started");
  const seconds = (performance.now() - windowStart) / 1000;
  return {
    p95GetChecksMs: percentile(getSamples, 0.95),
    p95PostResultsMs: percentile(postSamples, 0.95),
    p95GetLatencyMs: p95IfSent(latencyRate, latencySamples),
    p95GetCheckLatencyMs: p95IfSent(checkLatencyRate, checkLatencySamples),
    rps:
      (getSamples.length +
        postSamples.length +
        uptimeSamples.length +
        latencySamples.length +
        checkLatencySamples.length) /
      seconds,
    ...resets,
  };
}
