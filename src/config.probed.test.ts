import { expect, test } from "bun:test";
import { ConfigError, parseConfig } from "./config.ts";

const tcp = {
  id: "t",
  name: "T",
  type: "tcp" as const,
  host: "db.internal",
  port: 5432,
  intervalMs: 30000,
};
const dns = {
  id: "d",
  name: "D",
  type: "dns" as const,
  dnsName: "api",
  recordType: "A" as const,
  intervalMs: 60000,
};
const domain = {
  id: "m",
  name: "M",
  type: "domain" as const,
  domain: "example.com",
  warnDays: 30,
  intervalMs: 3_600_000,
};

function message(check: unknown): string {
  try {
    parseConfig({ checks: [check] });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a ConfigError");
}

test("tcp, dns and domain checks parse with resolved retries", () => {
  const { checks } = parseConfig({ checks: [tcp, dns, domain] });
  expect(checks).toEqual([
    { ...tcp, retries: 0, retryDelayMs: 1000 },
    { ...dns, retries: 0, retryDelayMs: 1000 },
    { ...domain, retries: 0, retryDelayMs: 1000 },
  ]);
});

test("optional dns fields and retries are kept", () => {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture, never contacted
  const full = { ...dns, expected: ["10.0.0.1"], resolver: "1.1.1.1", retries: 2, timeoutMs: 1000 };
  expect(parseConfig({ checks: [full] }).checks[0]).toMatchObject({ ...full, retryDelayMs: 1000 });
});

test("a domain interval under one hour is rejected, one hour is accepted", () => {
  expect(message({ ...domain, intervalMs: 3_599_999 })).toContain("at least 3600000");
  expect(() => parseConfig({ checks: [domain] })).not.toThrow();
});

test("port, record type and timer ranges are enforced", () => {
  expect(message({ ...tcp, port: 0 })).toContain("port");
  expect(message({ ...tcp, port: 65536 })).toContain("port");
  expect(message({ ...dns, recordType: "a" })).toContain("recordType");
  expect(message({ ...dns, expected: [] })).toContain("expected");
  expect(message({ ...dns, resolver: "1.1.1.1:53" })).toContain("resolver");
  expect(message({ ...tcp, intervalMs: 2 ** 31 })).toContain("intervalMs");
  expect(message({ ...domain, domain: "example" })).toContain("domain");
  expect(message({ ...tcp, retries: 11 })).toContain("retries");
});

test("unknown keys and http-only fields are rejected", () => {
  expect(message({ ...tcp, extra: 1 })).toBe("checks[0].extra: is not allowed on a tcp check");
  expect(message({ ...tcp, url: "https://x.example/" })).toBe(
    "checks[0].url is not allowed on a tcp check",
  );
  expect(message({ ...dns, keyword: "x" })).toContain("is not allowed on a dns check");
  expect(message({ ...domain, method: "GET" })).toContain("is not allowed on a domain check");
});

test("the worst case of the retries must fit in the interval", () => {
  expect(message({ ...tcp, intervalMs: 5000, retries: 3 })).toContain("worst case");
});
