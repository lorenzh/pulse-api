import { expect, test } from "bun:test";
import type { Check, CheckWithState } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

const NOW = 1_000_000;
const checks: Check[] = [
  {
    id: "tcp",
    name: "Tcp",
    type: "tcp",
    host: "db.internal",
    port: 5432,
    intervalMs: 30000,
    timeoutMs: 2000,
    retries: 1,
    retryDelayMs: 500,
  },
  {
    id: "dns",
    name: "Dns",
    type: "dns",
    dnsName: "api",
    recordType: "MX",
    expected: ["10 mail.example.com"],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture, never contacted
    resolver: "9.9.9.9",
    intervalMs: 60000,
    retries: 0,
    retryDelayMs: 1000,
  },
  {
    id: "dom",
    name: "Domain",
    type: "domain",
    domain: "example.com",
    warnDays: 30,
    intervalMs: 3_600_000,
    retries: 0,
    retryDelayMs: 1000,
  },
];

function setup(): ReturnType<typeof createService> {
  const service = createService(openDb(":memory:"), { now: () => NOW });
  service.upsertChecks(checks);
  return service;
}

test("the probe listing serves every target field as written", () => {
  expect(setup().listProbeChecks()).toEqual(checks);
});

test("the public listing serves the same targets as it does for tls host and port", () => {
  const listed = setup().listChecks();
  expect(listed.map((c) => c.type)).toEqual(["tcp", "dns", "domain"]);
  expect(listed[0]).toMatchObject({ host: "db.internal", port: 5432, timeoutMs: 2000 });
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture, never contacted
  expect(listed[1]).toMatchObject({ dnsName: "api", resolver: "9.9.9.9" });
  expect(listed[2]).toMatchObject({ domain: "example.com", warnDays: 30 });
});

test("a domain check stores and serves certDaysLeft like tls", () => {
  const service = setup();
  const result = {
    checkId: "dom",
    timestamp: NOW,
    status: "degraded" as const,
    statusCode: null,
    latencyMs: 5,
    reason: "domain expires in 3 days",
    location: "east",
    attempts: 1,
    certDaysLeft: 3,
  };
  service.ingest(result);
  const dom = service.listChecks().find((c) => c.id === "dom");
  expect(dom?.certDaysLeft).toBe(3);
  expect(service.listResults("dom", 10)[0]?.certDaysLeft).toBe(3);
  // a tcp result without days left carries none
  service.ingest({
    ...result,
    checkId: "tcp",
    status: "up",
    reason: null,
    certDaysLeft: undefined,
  });
  expect(service.listResults("tcp", 10)[0]).not.toHaveProperty("certDaysLeft");
});

test("changing the type of an id resets the columns of the old type", () => {
  const service = setup();
  const retyped: Check[] = [
    {
      id: "tcp",
      name: "Now http",
      url: "https://x.example/",
      intervalMs: 1000,
      retries: 0,
      retryDelayMs: 1000,
    },
    {
      id: "dns",
      name: "Now tcp",
      type: "tcp",
      host: "h",
      port: 1,
      intervalMs: 1000,
      retries: 0,
      retryDelayMs: 1000,
    },
    {
      id: "dom",
      name: "Now dns",
      type: "dns",
      dnsName: "x",
      recordType: "A",
      intervalMs: 1000,
      retries: 0,
      retryDelayMs: 1000,
    },
  ];
  service.upsertChecks(retyped);
  const served: CheckWithState[] = service.listChecks();
  expect(served[0]).not.toHaveProperty("host");
  expect(served[1]).not.toHaveProperty("dnsName");
  expect(served[1]).not.toHaveProperty("resolver");
  expect(served[2]).not.toHaveProperty("domain");
  expect(served[2]).not.toHaveProperty("expected");
  expect(service.listProbeChecks()).toEqual(retyped);
});

test("removing a check from the file keeps the others", () => {
  const service = setup();
  service.upsertChecks(checks.slice(0, 1));
  expect(service.listChecks().map((c) => c.id)).toEqual(["tcp"]);
});
