import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  type Check,
  type ChecksResponse,
  type ErrorResponse,
  type Result,
  validateChecksResponse,
  validatePostResultRequest,
  validateResultsResponse,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer, maxFutureSkewMs, validateResult } from "./server.ts";
import { createService } from "./service.ts";
import { openTokenStore } from "./token-import.ts";

const NOW = 10 * 86_400_000;

const base = {
  checkId: "c1",
  timestamp: NOW,
  status: "up",
  statusCode: 200,
  latencyMs: 5,
  reason: null,
  attempts: 1,
};

function rejected(patch: Record<string, unknown>, field: string): void {
  const out = validateResult({ ...base, ...patch }, NOW, () => undefined);
  assert.equal(typeof out, "string", JSON.stringify(patch));
  assert.match(String(out), new RegExp(`^(result\\.)?${field}\\b`), JSON.stringify(patch));
}

function accepted(patch: Record<string, unknown>): void {
  const out = validateResult({ ...base, ...patch }, NOW, () => undefined);
  assert.equal(typeof out, "object", `${JSON.stringify(patch)}: ${String(out)}`);
}

test("validateResult: timestamp must be an integer within the allowed window", () => {
  for (const v of [1.5, "1", Number.NaN, null]) rejected({ timestamp: v }, "timestamp");
  rejected({ timestamp: NOW + 60001 }, "timestamp");
  rejected({ timestamp: NOW - 604800001 }, "timestamp");
  accepted({ timestamp: NOW + 60000 });
  accepted({ timestamp: NOW - 604800000 });
});

test("validateResult: reason length", () => {
  rejected({ reason: "x".repeat(1001) }, "reason");
  accepted({ reason: "x".repeat(1000) });
});

test("validateResult: attempts bounds", () => {
  for (const v of [0, 101, 1.5, "2"]) rejected({ attempts: v }, "attempts");
  accepted({ attempts: 1 });
  accepted({ attempts: 100 });
});

test("validateResult: latencyMs bounds", () => {
  for (const v of [-1, -0.4, 2147483648, 2147483647.6, Number.POSITIVE_INFINITY, "1"])
    rejected({ latencyMs: v }, "latencyMs");
  accepted({ latencyMs: 0 });
  accepted({ latencyMs: 2147483647 });
});

test("validateResult: a finite fractional latency >= 0 is rounded", () => {
  const read = (v: number): unknown => {
    const out = validateResult({ ...base, latencyMs: v }, NOW, () => undefined);
    return typeof out === "object" ? out.latencyMs : out;
  };
  assert.equal(read(3.7), 4);
  assert.equal(read(2.5), 3);
  assert.equal(read(0.4), 0);
});

test("validateResult: accessors are rejected before rounding or validation reads them", () => {
  for (const field of ["latencyMs", "reason"]) {
    let reads = 0;
    const body = { ...base, latencyMs: 3.7 };
    Object.defineProperty(body, field, {
      enumerable: true,
      get: () => {
        reads += 1;
        return field === "latencyMs" ? 3.7 : null;
      },
    });
    assert.equal(
      validateResult(body, NOW, () => undefined),
      "body must not have accessor properties",
    );
    assert.equal(reads, 0);
  }
});

test("validateResult: statusCode is null or an integer 100-599", () => {
  for (const v of [99, 600, 200.5, "200", undefined]) rejected({ statusCode: v }, "statusCode");
  for (const v of [null, 100, 599]) accepted({ statusCode: v });
  const out = validateResult({ ...base, statusCode: null }, NOW, () => undefined) as Result;
  assert.equal(out.statusCode, null);
});

test("validateResult: a body the contract rejects gets a message naming the path", () => {
  assert.equal(
    validateResult({ ...base, latencyMs: "fast" }, NOW, () => undefined),
    "result.latencyMs: must be an integer 0..2147483647",
  );
  assert.equal(typeof validateResult([], NOW, () => undefined), "string");
});

const http = (intervalMs: number): Check => ({
  id: "c1",
  name: "c1",
  url: "https://x",
  intervalMs,
});

test("maxFutureSkewMs: the interval, capped at 60 s; 60 s for heartbeat and unknown checks", () => {
  assert.equal(maxFutureSkewMs(http(10_000)), 10_000);
  assert.equal(maxFutureSkewMs(http(60_000)), 60_000);
  assert.equal(maxFutureSkewMs(http(300_000)), 60_000);
  assert.equal(
    maxFutureSkewMs({ id: "h", name: "h", type: "heartbeat", period: 5000, grace: 0 }),
    60_000,
  );
  assert.equal(maxFutureSkewMs(undefined), 60_000);
});

test("validateResult: a 10 s check rejects a timestamp 30 s ahead and names the limit", () => {
  const find = (): Check => http(10_000);
  const out = validateResult({ ...base, timestamp: NOW + 30_000 }, NOW, find);
  assert.match(String(out), /^timestamp is more than 10000 ms in the future/);
  assert.equal(typeof validateResult({ ...base, timestamp: NOW + 10_000 }, NOW, find), "object");
  const slow = (): Check => http(300_000);
  assert.equal(typeof validateResult({ ...base, timestamp: NOW + 60_000 }, NOW, slow), "object");
  assert.equal(typeof validateResult({ ...base, timestamp: NOW + 60_001 }, NOW, slow), "string");
  assert.equal(
    typeof validateResult({ ...base, timestamp: NOW + 60_000 }, NOW, () => undefined),
    "object",
  );
});

const CERT_TEXT = "certDaysLeft must be null or an integer from -3000000 to 3000000";

test("validateResult: certDaysLeft is absent, null or an integer within 3000000", () => {
  for (const v of [1e9, 3000001, -3000001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      validateResult({ ...base, certDaysLeft: v }, NOW, () => undefined),
      CERT_TEXT,
    );
  }
  rejected({ certDaysLeft: 30.5 }, "certDaysLeft");
  for (const v of [3000000, -3000000, 0, null, 30, -5, 2_912_000, 40_000]) {
    const out = validateResult({ ...base, certDaysLeft: v }, NOW, () => undefined);
    assert.equal(typeof out === "object" ? out.certDaysLeft : out, v);
  }
  const absent = validateResult(base, NOW, () => undefined);
  assert.ok(typeof absent === "object" && !("certDaysLeft" in absent));
});

const PROBE = "probe-token-0123456789abcdef";
const TLS: Check = {
  id: "t",
  name: "T",
  type: "tls",
  host: "example.com",
  port: 443,
  warnDays: 14,
  intervalMs: 60_000,
};

test("POST /results: certDaysLeft out of range answers 400, a far expiry is stored and served", async () => {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks([TLS]);
  let lookups = 0;
  const counted = {
    ...service,
    findActiveCheck: (id: string) => {
      lookups += 1;
      return service.findActiveCheck(id);
    },
  };
  const server = createApiServer(counted, {
    tokenStore: openTokenStore(
      { db: openDb(":memory:"), now: () => 0 },
      { probe: [{ location: "default", token: PROBE }], admin: undefined },
    ),
    now: () => NOW,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (certDaysLeft: unknown, timestamp: number) =>
    fetch(`${host}/results`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PROBE}` },
      body: JSON.stringify({ ...base, checkId: "t", statusCode: null, timestamp, certDaysLeft }),
    });
  try {
    const bad = await post(1e9, NOW);
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()) as ErrorResponse, { error: CERT_TEXT });
    assert.equal(lookups, 1);
    assert.equal((await post(3_000_001, NOW)).status, 400);
    assert.equal((await post(2_912_000, NOW)).status, 204);
    assert.equal(lookups, 3);
    const checks = (await (await fetch(`${host}/checks`)).json()) as ChecksResponse;
    assert.equal(checks[0]?.certDaysLeft, 2_912_000);
    assert.equal((await post(null, NOW + 1)).status, 204);
    assert.equal(service.listResults("t", 10)[0]?.certDaysLeft, null);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
});

async function startApi(service: ReturnType<typeof createService>) {
  const server = createApiServer(service, {
    tokenStore: openTokenStore(
      { db: openDb(":memory:"), now: () => NOW },
      { probe: [{ location: "default", token: PROBE }], admin: undefined },
    ),
    now: () => NOW,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { host, close };
}

const TCP: Check = {
  id: "p",
  name: "P",
  type: "tcp",
  host: "example.com",
  port: 443,
  intervalMs: 60_000,
};

function postRaw(host: string, body: string): Promise<Response> {
  return fetch(`${host}/results`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${PROBE}` },
    body,
  });
}

test("POST /results: fractional latency is rounded, bad latency and long reasons answer 400", async () => {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks([TCP]);
  const { host, close } = await startApi(service);
  let ts = NOW - 1000;
  const body = (patch: Record<string, unknown>) => {
    ts += 1;
    return JSON.stringify({ ...base, checkId: "p", timestamp: ts, ...patch });
  };
  try {
    assert.equal((await postRaw(host, body({ latencyMs: 3.7 }))).status, 204);
    assert.equal(service.listResults("p", 1)[0]?.latencyMs, 4);
    assert.equal((await postRaw(host, body({ latencyMs: 2.5 }))).status, 204);
    assert.equal(service.listResults("p", 1)[0]?.latencyMs, 3);
    for (const v of [-0.4, -1, 2147483647.6, "5"]) {
      const res = await postRaw(host, body({ latencyMs: v }));
      assert.equal(res.status, 400, String(v));
      assert.match(((await res.json()) as ErrorResponse).error, /latencyMs/);
    }
    ts += 1;
    const nan = `{"checkId":"p","timestamp":${ts},"status":"up","statusCode":200,"latencyMs":NaN,"reason":null}`;
    assert.equal((await postRaw(host, nan)).status, 400);
    assert.equal((await postRaw(host, body({ latencyMs: 2147483647 }))).status, 204);
    assert.equal(service.listResults("p", 1)[0]?.latencyMs, 2147483647);
    const down = { status: "down", statusCode: null };
    assert.equal((await postRaw(host, body({ ...down, reason: "r".repeat(1000) }))).status, 204);
    assert.equal((await postRaw(host, body({ ...down, reason: "r".repeat(1001) }))).status, 400);
    assert.equal(service.listResults("p", 100).length, 4);
  } finally {
    await close();
  }
});

test("POST /results: capped probe reasons reach ingestion unchanged; an uncapped one is refused", async () => {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks([TCP]);
  const { host, close } = await startApi(service);
  const redirect = `redirect to http://${"a".repeat(73)}… not followed`;
  const tcp = `${"m".repeat(999)}…`;
  const post = (statusCode: number | null, reason: string, timestamp: number) =>
    postRaw(
      host,
      JSON.stringify({
        checkId: "p",
        timestamp,
        status: "down",
        statusCode,
        latencyMs: 0,
        reason,
        attempts: 1,
      }),
    );
  try {
    assert.equal((await post(302, redirect, NOW - 2)).status, 204);
    assert.equal((await post(null, tcp, NOW - 1)).status, 204);
    const stored = service.listResults("p", 10);
    const served = (await (await fetch(`${host}/checks/p/results`)).json()) as Result[];
    for (const list of [stored, served]) {
      assert.equal(list.length, 2);
      const [b, a] = list;
      assert.equal(a?.status, "down");
      assert.equal(a?.statusCode, 302);
      assert.equal(a?.reason, redirect);
      assert.equal(a?.reason?.length, 106);
      assert.equal(b?.status, "down");
      assert.equal(b?.statusCode, null);
      assert.equal(b?.reason, tcp);
      assert.equal(b?.reason?.length, 1000);
    }
    assert.equal((await post(null, `${"m".repeat(1000)}…`, NOW)).status, 400);
    assert.equal(service.listResults("p", 10).length, 2);
  } finally {
    await close();
  }
});

test("served history is normalized: 12.5 ms reads 13, a 1500-character reason reads 1000", async () => {
  const db = openDb(":memory:");
  const service = createService(db, { now: () => NOW });
  service.upsertChecks([TCP]);
  db.run(
    "INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["p", NOW - 5, "down", null, 12.5, "x".repeat(1500), "default", 1],
  );
  const { host, close } = await startApi(service);
  try {
    const raw: unknown = await (await fetch(`${host}/checks/p/results`)).json();
    const results = validateResultsResponse(raw);
    assert.ok(results.ok, results.ok ? "" : results.error);
    const [r] = results.value;
    assert.equal(r?.latencyMs, 13);
    assert.equal(r?.reason?.length, 1000);
    assert.equal(r?.reason?.endsWith("x…"), true);
    const rawChecks: unknown = await (await fetch(`${host}/checks`)).json();
    const checks = validateChecksResponse(rawChecks);
    assert.ok(checks.ok, checks.ok ? "" : checks.error);
    const loc = checks.value[0]?.locations[0]?.result;
    assert.equal(loc?.latencyMs, 13);
    assert.equal(loc?.reason?.length, 1000);
  } finally {
    await close();
  }
});

const unknownCheck = (): undefined => undefined;

function apiText(body: unknown, find: (id: string) => Check | undefined = unknownCheck): string {
  const out = validateResult(body, NOW, find);
  return typeof out === "string" ? out : "ok";
}

function contractText(body: unknown): string {
  const out = validatePostResultRequest(body);
  return out.ok ? "ok" : out.error;
}

function acceptedResult(patch: Record<string, unknown>): Result {
  const out = validateResult({ ...base, ...patch }, NOW, unknownCheck);
  assert.equal(typeof out, "object", `${JSON.stringify(patch)}: ${String(out)}`);
  return out as Result;
}

const REASON_TEXT = "result.reason: must be null or a string of at most 1000 characters";
const LATENCY_TEXT = "result.latencyMs: must be an integer 0..2147483647";
const ATTEMPTS_TEXT = "attempts must be an integer from 1 to 100";
const OLD_TEXT = "timestamp is older than 7 days";
const LOCATION_TEXT = "location must be at most 64 characters";

test("validateResult: a field the contract rejects gives the contract message", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ reason: "x".repeat(1001) }, REASON_TEXT],
    [{ reason: 5 }, "result.reason: must be a string"],
    [{ latencyMs: 2147483648 }, LATENCY_TEXT],
    [{ latencyMs: -1 }, LATENCY_TEXT],
    [{ latencyMs: 2147483647.5 }, LATENCY_TEXT],
    [{ latencyMs: "1" }, LATENCY_TEXT],
    [{ checkId: "" }, "result.checkId: must be a non-empty string"],
    [{ status: "ok" }, 'result.status: must be one of "up", "degraded", "down"'],
    [{ statusCode: 99 }, "result.statusCode: must be an integer 100..599"],
    [{ statusCode: 600 }, "result.statusCode: must be an integer 100..599"],
    [{ statusCode: "200" }, "result.statusCode: must be an integer 100..599"],
    [{ timestamp: 1.5 }, "result.timestamp: must be an integer"],
    [{ timestamp: "1" }, "result.timestamp: must be an integer"],
    [{ attempts: 0 }, "result.attempts: must be an integer >= 1"],
    [{ attempts: 1.5 }, "result.attempts: must be an integer >= 1"],
    [{ certDaysLeft: 1.5 }, "result.certDaysLeft: must be an integer"],
    [{ location: 5 }, "result.location: must be a string"],
  ];
  for (const [patch, text] of cases) {
    const body = { ...base, ...patch };
    assert.equal(apiText(body), text, JSON.stringify(patch));
    if (patch.latencyMs !== 2147483647.5) assert.equal(contractText(body), text);
  }
  for (const body of [[], null, "x"]) {
    assert.equal(apiText(body), "result: must be an object");
    assert.equal(contractText(body), "result: must be an object");
  }
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -0.4]) {
    assert.equal(apiText({ ...base, latencyMs: v }), LATENCY_TEXT, String(v));
  }
});

test("validateResult: reason length counts UTF-16 code units", () => {
  for (const reason of [null, "", "x".repeat(1000), `${"x".repeat(998)}😀`]) {
    assert.equal(acceptedResult({ reason }).reason, reason);
  }
  for (const reason of ["x".repeat(1001), `${"x".repeat(999)}😀`]) {
    assert.equal(apiText({ ...base, reason }), REASON_TEXT);
  }
});

test("validateResult: latency bounds and rounding", () => {
  assert.equal(acceptedResult({ latencyMs: 0 }).latencyMs, 0);
  assert.equal(acceptedResult({ latencyMs: 2147483647 }).latencyMs, 2147483647);
  assert.equal(acceptedResult({ latencyMs: 2147483647.4 }).latencyMs, 2147483647);
  assert.equal(acceptedResult({ latencyMs: 12.5 }).latencyMs, 13);
  assert.equal(acceptedResult({ latencyMs: 0.4 }).latencyMs, 0);
});

test("validateResult: API-only bounds of attempts and certDaysLeft", () => {
  assert.equal(acceptedResult({ attempts: 100 }).attempts, 100);
  assert.equal(apiText({ ...base, attempts: 101 }), ATTEMPTS_TEXT);
  assert.equal(contractText({ ...base, attempts: 101 }), "ok");
  const noAttempts = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "attempts"));
  assert.equal(acceptedResult(noAttempts).attempts, 1);
  for (const v of [3_000_000, -3_000_000, null]) {
    assert.equal(acceptedResult({ certDaysLeft: v }).certDaysLeft, v);
  }
  for (const v of [3_000_001, -3_000_001]) {
    assert.equal(apiText({ ...base, certDaysLeft: v }), CERT_TEXT);
    assert.equal(contractText({ ...base, certDaysLeft: v }), "ok");
  }
  assert.ok(!("certDaysLeft" in acceptedResult({})));
});

test("validateResult: timestamp window bounds are inclusive", () => {
  acceptedResult({ timestamp: NOW - 604_800_000 });
  assert.equal(apiText({ ...base, timestamp: NOW - 604_800_001 }), OLD_TEXT);
  acceptedResult({ timestamp: NOW + 60_000 });
  assert.equal(
    apiText({ ...base, timestamp: NOW + 60_001 }),
    "timestamp is more than 60000 ms in the future",
  );
  const heartbeat = (): Check => ({
    id: "c1",
    name: "h",
    type: "heartbeat",
    period: 5000,
    grace: 0,
  });
  assert.equal(apiText({ ...base, timestamp: NOW + 60_000 }, heartbeat), "ok");
  assert.equal(
    apiText({ ...base, timestamp: NOW + 60_001 }, heartbeat),
    "timestamp is more than 60000 ms in the future",
  );
  const fast = (): Check => http(10_000);
  assert.equal(apiText({ ...base, timestamp: NOW + 10_000 }, fast), "ok");
  assert.equal(
    apiText({ ...base, timestamp: NOW + 10_001 }, fast),
    "timestamp is more than 10000 ms in the future",
  );
});

test("validateResult: location is trimmed, defaulted and limited to 64", () => {
  assert.equal(acceptedResult({}).location, "default");
  assert.equal(acceptedResult({ location: "   " }).location, "default");
  assert.equal(acceptedResult({ location: "  eu  " }).location, "eu");
  assert.equal(acceptedResult({ location: "EU" }).location, "EU");
  assert.equal(acceptedResult({ location: ` ${"a".repeat(64)} ` }).location, "a".repeat(64));
  assert.equal(apiText({ ...base, location: "a".repeat(65) }), LOCATION_TEXT);
  assert.equal(apiText({ ...base, location: `  ${"a".repeat(65)} ` }), LOCATION_TEXT);
});

test("validateResult: the contract runs first, then timestamp, certDaysLeft, attempts, location", () => {
  const cases: [Record<string, unknown>, string][] = [
    [
      { status: "ok", attempts: 101, reason: "x".repeat(1001) },
      'result.status: must be one of "up", "degraded", "down"',
    ],
    [{ status: "ok", attempts: 101 }, 'result.status: must be one of "up", "degraded", "down"'],
    [{ timestamp: NOW - 604_800_001, attempts: 101 }, OLD_TEXT],
    [{ certDaysLeft: 3_000_001, attempts: 101 }, CERT_TEXT],
    [{ attempts: 101, location: "a".repeat(65) }, ATTEMPTS_TEXT],
  ];
  for (const [patch, text] of cases) assert.equal(apiText({ ...base, ...patch }), text);
  let lookups = 0;
  const counted = (): undefined => {
    lookups += 1;
    return undefined;
  };
  apiText({ ...base, status: "ok" }, counted);
  assert.equal(lookups, 0);
  apiText({ ...base, attempts: 101 }, counted);
  assert.equal(lookups, 1);
});

test("validateResult: only known fields reach the Result", () => {
  const out = acceptedResult({ extra: 1, location: "eu", certDaysLeft: 9 });
  assert.deepEqual(out, {
    checkId: "c1",
    timestamp: NOW,
    status: "up",
    statusCode: 200,
    latencyMs: 5,
    reason: null,
    location: "eu",
    attempts: 1,
    certDaysLeft: 9,
  });
});

test("POST /results: API-only rejections answer 400 and store nothing", async () => {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks([TCP]);
  const { host, close } = await startApi(service);
  const cases: [Record<string, unknown>, string][] = [
    [{ reason: "x".repeat(1001) }, REASON_TEXT],
    [{ attempts: 101 }, ATTEMPTS_TEXT],
    [{ certDaysLeft: 3_000_001 }, CERT_TEXT],
    [{ location: "a".repeat(65) }, LOCATION_TEXT],
  ];
  try {
    for (const [patch, text] of cases) {
      const res = await postRaw(host, JSON.stringify({ ...base, checkId: "p", ...patch }));
      assert.equal(res.status, 400, text);
      assert.deepEqual((await res.json()) as ErrorResponse, { error: text });
    }
    assert.equal(service.listResults("p", 10).length, 0);
  } finally {
    await close();
  }
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpusBody(i: number, rand: () => number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const valid = {
    checkId: "p",
    timestamp: NOW - 100_000 + i,
    status: pick(["up", "degraded", "down"]),
    statusCode: pick([null, 100, 200, 503, 599]),
    latencyMs: Math.floor(rand() * 5000),
    reason: pick([null, "", "slow"]),
  };
  const variants: (() => unknown)[] = [
    () => valid,
    () => ({ ...valid, reason: pick(["x", "😀"]).repeat(999 + Math.floor(rand() * 4)) }),
    () => ({ ...valid, latencyMs: 2147483646 + pick([0, 1, 2, 1.4, 1.5, 3]) }),
    () => ({ ...valid, checkId: pick(["", 5, null, "p"]) }),
    () => ({ ...valid, status: pick(["ok", "UP", "", 1, "down"]) }),
    () => ({
      ...valid,
      [pick(["timestamp", "statusCode", "latencyMs", "reason", "status"])]: pick([
        "1",
        true,
        [],
        {},
      ]),
    }),
    () => ({ ...valid, attempts: pick([0, 1, 100, 101, 1.5, 250, "2"]) }),
    () => ({
      ...valid,
      timestamp: NOW + pick([-604_800_000, -604_800_001, 60_000, 60_001, 0.5, 0]),
    }),
    () => ({
      ...valid,
      location: " ".repeat(pick([0, 2])) + pick(["a", "B"]).repeat(pick([0, 63, 64, 65])),
    }),
    () => ({ ...valid, latencyMs: pick([-0.4, 0.4, 12.5]) + Math.floor(rand() * 100) / 10 }),
    () => ({
      ...valid,
      certDaysLeft: pick([3_000_000, -3_000_000, 3_000_001, -3_000_001, null, 1.5]),
    }),
    () => pick([[], null, "x", 5, { ...valid, checkId: "unknown" }, { ...valid, extra: 1 }]),
  ];
  return variants[i % variants.length]?.();
}

test("POST /results: a seeded corpus of 360 requests answers like the base revision", async () => {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks([TCP]);
  const { host, close } = await startApi(service);
  const rand = seeded(860);
  const answers: string[] = [];
  try {
    for (let i = 0; i < 360; i += 1) {
      const res = await postRaw(host, JSON.stringify(corpusBody(i, rand)));
      answers.push(`${res.status} ${await res.text()}`);
    }
  } finally {
    await close();
  }
  assert.equal(answers.length, 360);
  const digest = createHash("sha256").update(answers.join("\n")).digest("hex");
  assert.equal(digest, "c1190ab79768eac901c054f4e6cdd59560e017254477b2e66889a434b5857699");
});
