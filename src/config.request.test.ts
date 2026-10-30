import { test } from "bun:test";
import assert from "node:assert/strict";
import { ConfigError, parseChecks } from "./config.ts";

const ok = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };

const SECRET = "s3cret-sentinel";

function messageOf(check: Record<string, unknown>): string {
  try {
    parseChecks({ checks: [check] });
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.message;
  }
  throw new Error("expected a ConfigError");
}

test("config: accepts the request options on an http check", () => {
  const options = {
    method: "POST",
    headers: {
      Authorization: { env: "PULSE_HEADER_SVC_TOKEN" },
      "Content-Type": "application/json",
    },
    body: '{"a":1}',
    expectedStatus: [200, "300-399"],
    jsonAssert: [
      { pointer: "/status", equals: "ok" },
      { pointer: "/id", exists: true },
    ],
  };
  const [check] = parseChecks({ checks: [{ ...ok, ...options }] });
  assert.deepEqual(check, { ...ok, retries: 0, retryDelayMs: 1000, ...options });
});

test("config: leaves the options out when not set", () => {
  const [check] = parseChecks({ checks: [ok] });
  assert.deepEqual(
    Object.keys(check ?? {}).sort((a, b) => a.localeCompare(b)),
    ["id", "intervalMs", "name", "retries", "retryDelayMs", "url"],
  );
});

test("config: rejects bad options with the field path", () => {
  assert.match(messageOf({ ...ok, method: "post" }), /^checks\[0\]\.method: /);
  assert.match(messageOf({ ...ok, body: "x" }), /^checks\[0\]\.body: is not allowed with GET/);
  assert.match(messageOf({ ...ok, method: "HEAD", keyword: "x" }), /keyword: is not allowed/);
  assert.match(messageOf({ ...ok, expectedStatus: [99] }), /^checks\[0\]\.expectedStatus/);
  assert.match(messageOf({ ...ok, expectedStatus: [] }), /^checks\[0\]\.expectedStatus/);
  assert.match(messageOf({ ...ok, headers: { Host: "x" } }), /^checks\[0\]\.headers\.Host: /);
  assert.match(messageOf({ ...ok, headers: { A: { env: "1BAD" } } }), /^checks\[0\]\.headers\.A/);
  assert.match(messageOf({ ...ok, jsonAssert: [{ pointer: "/a" }] }), /^checks\[0\]\.jsonAssert/);
});

test("config: an error message never quotes a header value or a body", () => {
  // The same options without the one bad field are accepted and kept, so the check below
  // fails on the bad field and not on an unknown option.
  const valid = { method: "POST", headers: { Authorization: SECRET }, body: SECRET };
  const [kept] = parseChecks({ checks: [{ ...ok, ...valid }] });
  assert.deepEqual(kept, { ...ok, retries: 0, retryDelayMs: 1000, ...valid });
  const message = messageOf({
    ...ok,
    method: "POST",
    headers: { "Bad Name": SECRET, Authorization: SECRET },
    body: SECRET,
    expectedStatus: [SECRET],
  });
  assert.ok(!message.includes(SECRET));
  assert.ok(!messageOf({ ...ok, body: SECRET }).includes(SECRET));
});

test("config: tls and heartbeat checks reject every request option", () => {
  const tls = { id: "t", name: "T", type: "tls", host: "example.com", intervalMs: 1000 };
  const heartbeat = { id: "h", name: "H", type: "heartbeat", period: 1000, secret: "a".repeat(16) };
  const fields = {
    method: "GET",
    headers: {},
    body: "x",
    expectedStatus: [200],
    jsonAssert: [{ pointer: "", exists: true }],
  };
  for (const [key, value] of Object.entries(fields)) {
    assert.match(messageOf({ ...tls, [key]: value }), new RegExp(`${key} is not allowed on a tls`));
    assert.match(messageOf({ ...heartbeat, [key]: value }), new RegExp(`"${key}"`));
  }
});
