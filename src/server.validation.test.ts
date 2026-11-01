import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  type Check,
  type ChecksResponse,
  type ErrorResponse,
  type Result,
  validateChecksResponse,
  validateResultsResponse,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import {
  createApiServer,
  MAX_ATTEMPTS,
  MAX_CERT_DAYS,
  MAX_FUTURE_SKEW_MS,
  MAX_LATENCY_MS,
  MAX_REASON_LENGTH,
  MAX_RESULT_AGE_MS,
  maxFutureSkewMs,
  validateResult,
} from "./server.ts";
import { createService } from "./service.ts";

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
  rejected({ timestamp: NOW + MAX_FUTURE_SKEW_MS + 1 }, "timestamp");
  rejected({ timestamp: NOW - MAX_RESULT_AGE_MS - 1 }, "timestamp");
  accepted({ timestamp: NOW + MAX_FUTURE_SKEW_MS });
  accepted({ timestamp: NOW - MAX_RESULT_AGE_MS });
});

test("validateResult: reason length", () => {
  rejected({ reason: "x".repeat(MAX_REASON_LENGTH + 1) }, "reason");
  accepted({ reason: "x".repeat(MAX_REASON_LENGTH) });
});

test("validateResult: attempts bounds", () => {
  for (const v of [0, MAX_ATTEMPTS + 1, 1.5, "2"]) rejected({ attempts: v }, "attempts");
  accepted({ attempts: 1 });
  accepted({ attempts: MAX_ATTEMPTS });
});

test("validateResult: latencyMs bounds", () => {
  assert.equal(MAX_LATENCY_MS, 2147483647);
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

test("validateResult: certDaysLeft is absent, null or an integer within MAX_CERT_DAYS", () => {
  assert.equal(MAX_CERT_DAYS, 3_000_000);
  for (const v of [1e9, 3_000_001, -3_000_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      validateResult({ ...base, certDaysLeft: v }, NOW, () => undefined),
      CERT_TEXT,
    );
  }
  rejected({ certDaysLeft: 30.5 }, "certDaysLeft");
  for (const v of [3_000_000, -3_000_000, 0, null, 30, -5, 2_912_000, 40_000]) {
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
    tokens: [{ location: "default", token: PROBE }],
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
    tokens: [{ location: "default", token: PROBE }],
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
