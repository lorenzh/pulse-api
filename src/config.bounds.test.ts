import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, parseChecks, parseConfig } from "./config.ts";

const MAX = 2147483647;
const http = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };
const tls = { id: "t", name: "T", type: "tls", host: "example.org", intervalMs: 1000 };

function rejects(data: unknown, field: string): void {
  assert.throws(
    () => parseConfig(data),
    (err: unknown) => err instanceof ConfigError && err.message.includes(field),
    field,
  );
}

test("config bounds: timer fields accept the cap and reject cap + 1", () => {
  for (const field of ["intervalMs", "timeoutMs", "latencyObjectiveMs"]) {
    assert.doesNotThrow(() => parseChecks({ checks: [{ ...http, [field]: MAX }] }), field);
    rejects({ checks: [{ ...http, [field]: MAX + 1 }] }, `checks[0].${field}`);
  }
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...tls, intervalMs: MAX }] }));
  rejects({ checks: [{ ...tls, intervalMs: MAX + 1 }] }, "checks[0].intervalMs");
});

test("config bounds: retries, retryDelayMs, port and warnDays", () => {
  rejects({ checks: [{ ...http, intervalMs: MAX, retries: 11 }] }, "retries");
  rejects({ checks: [{ ...http, intervalMs: MAX, retryDelayMs: 60001 }] }, "retryDelayMs");
  rejects({ checks: [{ ...tls, port: 65536 }] }, "port");
  rejects({ checks: [{ ...tls, port: 0 }] }, "port");
  rejects({ checks: [{ ...tls, warnDays: -1 }] }, "warnDays");
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...tls, warnDays: 0 }] }));
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...tls, warnDays: 100000 }] }));
});

test("config bounds: heartbeat period and grace keep their range", () => {
  const hb = { id: "h", name: "H", type: "heartbeat", period: 1000, secret: "s".repeat(16) };
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...hb, period: 86_400_000 }] }));
  rejects({ checks: [{ ...hb, period: 86_400_001 }] }, "period");
  rejects({ checks: [{ ...hb, grace: 86_400_001 }] }, "grace");
});

test("config bounds: maintenance dates reject calendar rollover", () => {
  const win = (start: string, end: string) => ({
    checks: [http],
    maintenance: [{ checkId: "a", start, end, note: "n" }],
  });
  rejects(win("2030-02-30T00:00:00Z", "2030-03-05T00:00:00Z"), "maintenance[0].start");
  rejects(win("2030-03-01T00:00:00Z", "2030-04-31T00:00:00Z"), "maintenance[0].end");
  rejects(win("2029-02-29T00:00:00Z", "2030-03-05T00:00:00Z"), "maintenance[0].start");
  rejects(win("2030-03-01T24:00:00Z", "2030-03-05T00:00:00Z"), "maintenance[0].start");
  rejects(win("2030-03-05T00:00:00Z", "2030-03-05T00:00:00Z"), "maintenance[0].end");
  const leap = parseConfig(win("2028-02-29T00:00:00Z", "2028-03-01T00:00:00Z"));
  assert.equal(leap.maintenance[0]?.start, Date.parse("2028-02-29T00:00:00Z"));
});
