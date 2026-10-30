import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Check, Result } from "@lorenzh/pulse-contract";
import {
  MAX_ATTEMPTS,
  MAX_FUTURE_SKEW_MS,
  MAX_LATENCY_MS,
  MAX_REASON_LENGTH,
  MAX_RESULT_AGE_MS,
  maxFutureSkewMs,
  validateResult,
} from "./server.ts";

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
