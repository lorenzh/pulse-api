import { test } from "bun:test";
import assert from "node:assert/strict";
import { ConfigError, parseChecks } from "./config.ts";

const BASES = [
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
  { id: "h", name: "H", url: "http://h/", intervalMs: 60_000 },
  { id: "t", name: "T", type: "tls", host: "x", intervalMs: 60_000 },
  { id: "p", name: "P", type: "tcp", host: "x", port: 1, intervalMs: 60_000 },
  { id: "d", name: "D", type: "dns", dnsName: "x.example", recordType: "A", intervalMs: 60_000 },
  { id: "o", name: "O", type: "domain", domain: "x.example", warnDays: 7, intervalMs: 3_600_000 },
  { id: "b", name: "B", type: "heartbeat", period: 60_000, secret: "0123456789abcdef" },
];

test("availabilityTarget is accepted on every check type and kept", () => {
  const checks = parseChecks({ checks: BASES.map((b) => ({ ...b, availabilityTarget: 99.9 })) });
  assert.deepEqual(
    checks.map((c) => c.availabilityTarget),
    BASES.map(() => 99.9),
  );
});

test("availabilityTarget is optional and rejects values outside 90 <= x < 100", () => {
  assert.equal(parseChecks({ checks: [BASES[0]] })[0]?.availabilityTarget, undefined);
  assert.equal(
    parseChecks({ checks: [{ ...BASES[0], availabilityTarget: 90 }] })[0]?.availabilityTarget,
    90,
  );
  for (const bad of [89.9, 100, Number.NaN, "99", null]) {
    for (const base of BASES) {
      assert.throws(
        () => parseChecks({ checks: [{ ...base, availabilityTarget: bad }] }),
        ConfigError,
        `${base.id} ${String(bad)}`,
      );
    }
  }
});
