import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TlsCheck } from "@lorenzh/pulse-contract";
import { ConfigError, parseChecks } from "./config.ts";
import { openDb } from "./db.ts";
import { validateResult } from "./server.ts";
import { createService } from "./service.ts";

const tls = { id: "t", name: "T", type: "tls", host: "example.com", intervalMs: 1000 };

test("config: tls defaults and explicit values", () => {
  assert.deepEqual(parseChecks({ checks: [tls] }), [{ ...tls, port: 443, warnDays: 14 }]);
  const full = { ...tls, port: 8443, warnDays: 30, timeoutMs: 200 };
  assert.deepEqual(parseChecks({ checks: [full] }), [full]);
  assert.deepEqual(
    parseChecks({
      checks: [
        {
          id: "h",
          name: "H",
          type: "http",
          // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
          url: "http://x/",
          intervalMs: 5,
        },
      ],
    }),
    [
      {
        id: "h",
        name: "H",
        type: "http",
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
        url: "http://x/",
        intervalMs: 5,
        retries: 0,
        retryDelayMs: 1000,
      },
    ],
  );
});

test("config: rejects invalid tls checks and unknown types", () => {
  const bad: object[] = [
    { ...tls, type: "ftp" },
    { ...tls, host: undefined },
    { ...tls, host: "" },
    { ...tls, host: "https://example.com" },
    { ...tls, host: "example.com/path" },
    { ...tls, host: "example.com:443" },
    { ...tls, port: 0 },
    { ...tls, port: 65536 },
    { ...tls, port: 1.5 },
    { ...tls, warnDays: -1 },
    { ...tls, warnDays: 1.5 },
    { ...tls, intervalMs: undefined },
    { ...tls, timeoutMs: 0 },
  ];
  for (const b of bad)
    assert.throws(() => parseChecks({ checks: [b] }), ConfigError, JSON.stringify(b));
});

const check: TlsCheck = { ...tls, type: "tls", port: 443, warnDays: 14 };

function res(t: number, status: "up" | "down", location = "default", days: number | null = 5) {
  return {
    checkId: "t",
    timestamp: t,
    status,
    statusCode: null,
    latencyMs: 3,
    reason: status === "down" ? "certificate expires in 5 days" : null,
    location,
    attempts: 1,
    certDaysLeft: days,
  } as const;
}

test("service: tls check round-trips with certDaysLeft from the latest result", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  assert.equal(s.listChecks()[0]!.certDaysLeft, null);
  s.ingest(res(1, "down"));
  const c = s.listChecks()[0]!;
  assert.equal(c.type, "tls");
  assert.deepEqual(
    { host: (c as TlsCheck).host, port: (c as TlsCheck).port, w: (c as TlsCheck).warnDays },
    {
      host: "example.com",
      port: 443,
      w: 14,
    },
  );
  assert.equal(c.certDaysLeft, 5);
  assert.equal(c.locations[0]!.result.certDaysLeft, 5);
  s.ingest(res(2, "up", "default", 90));
  assert.equal(s.listChecks()[0]!.certDaysLeft, 90);
  assert.deepEqual(
    s.listResults("t", 10).map((r) => r.certDaysLeft),
    [90, 5],
  );
  s.ingest(res(3, "down", "default", null));
  assert.equal(s.listResults("t", 1)[0]!.certDaysLeft, null);
});

test("service: tls results open and resolve incidents", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const t of [1, 2, 3]) s.ingest(res(t, "down"));
  assert.equal(s.listIncidents("open").length, 1);
  s.ingest(res(4, "up", "default", 90));
  assert.equal(s.listIncidents("open").length, 0);
  assert.equal(s.listIncidents("resolved").length, 1);
});

test("service: tls results work with quorum", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([check]);
  for (const t of [1, 2, 3]) {
    s.ingest(res(t * 10, "down", "a"));
    s.ingest(res(t * 10 + 1, "up", "b", 90));
  }
  assert.equal(s.listIncidents().length, 0);
  assert.equal(s.listChecks()[0]!.state, "up");
  for (const t of [4, 5, 6]) {
    s.ingest(res(t * 10, "down", "a"));
    s.ingest(res(t * 10 + 1, "down", "b"));
  }
  assert.equal(s.listIncidents("open").length, 1);
});

test("service: tls results work with maintenance windows", () => {
  const s = createService(openDb(":memory:"), {
    maintenance: [{ checkId: "t", start: 0, end: 100, note: "n" }],
    now: () => 50,
  });
  s.upsertChecks([check]);
  for (const t of [1, 2, 3, 4]) s.ingest(res(t, "down"));
  assert.deepEqual(s.listIncidents(), []);
  assert.equal(s.listChecks()[0]!.state, "maintenance");
});

test("server: validateResult accepts and checks certDaysLeft", () => {
  const body = { ...res(1, "down") };
  assert.deepEqual(
    validateResult(body, 1, () => undefined),
    body,
  );
  assert.deepEqual(
    validateResult({ ...body, certDaysLeft: null }, 1, () => undefined),
    {
      ...body,
      certDaysLeft: null,
    },
  );
  assert.equal(typeof validateResult({ ...body, certDaysLeft: "5" }, 1, () => undefined), "string");
  assert.equal(typeof validateResult({ ...body, certDaysLeft: 1.5 }, 1, () => undefined), "string");
  // eslint-disable-next-line sonarjs/no-unused-vars -- rest destructuring omits a property to build the test input
  const { certDaysLeft: _omit, ...legacy } = body;
  assert.equal("certDaysLeft" in (validateResult(legacy, 1, () => undefined) as object), false);
});
