import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Check, ChecksResponse, ErrorResponse, Result } from "@lorenzh/pulse-contract";
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
  for (const v of [-1, MAX_LATENCY_MS + 1, Number.POSITIVE_INFINITY, "1"])
    rejected({ latencyMs: v }, "latencyMs");
  accepted({ latencyMs: 0 });
  accepted({ latencyMs: MAX_LATENCY_MS });
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
    "result.latencyMs: must be a finite number >= 0",
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
