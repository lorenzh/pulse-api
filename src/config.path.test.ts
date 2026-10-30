import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { parseTokens } from "./tokens.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture
const http = { id: "a", name: "A", url: "http://a/", intervalMs: 1000 };
const tls = { id: "t", name: "T", type: "tls", host: "example.com", intervalMs: 1000 };

test("a field error names the path: checks[1].port", () => {
  assert.throws(() => parseConfig({ checks: [http, { ...tls, port: 70000 }] }), {
    message: "checks[1].port must be an integer from 1 to 65535",
  });
});

test("a wrong type reads like an out-of-range value", () => {
  assert.throws(() => parseConfig({ checks: [{ ...http, intervalMs: "1000" }] }), {
    message: "checks[0].intervalMs must be an integer from 1 to 2147483647 (milliseconds)",
  });
});

test("a tls check rejects a keyword", () => {
  assert.throws(() => parseConfig({ checks: [{ ...tls, keyword: "x" }] }), {
    message: "checks[0].keyword is not allowed on a tls check",
  });
});

test("a bad maintenance window names its field", () => {
  const w = { checkId: "a", start: "2030-01-01T00:00:00Z", end: "2030-02-30T00:00:00Z", note: "n" };
  assert.throws(() => parseConfig({ checks: [http], maintenance: [w] }), {
    message: "maintenance[0].end is not a valid date",
  });
});

test("a token message names the location and never the token", () => {
  const token = "short token";
  try {
    parseTokens({ tokens: [{ location: " eu ", token }] });
    assert.fail("expected a TokensError");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.equal(
      err.message,
      'tokens[0] (location "eu") token must be a string of at least 16 characters',
    );
    assert.ok(!err.message.includes(token));
  }
});
