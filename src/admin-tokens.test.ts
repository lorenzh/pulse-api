import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertDistinctDigests, parseAdminTokens } from "./admin-tokens.ts";
import { EXAMPLE_TOKENS, parseTokens, TokensError } from "./tokens.ts";

const A = "admin-a-0123456789abcdef0123456789abcdef";
const B = "admin-b-0123456789abcdef0123456789abcdef";

function rejects(data: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseAdminTokens(data),
    (err: unknown) => err instanceof TokensError && pattern.test(err.message),
  );
}

test("parseAdminTokens: accepts entries and trims the name", () => {
  assert.deepEqual(parseAdminTokens({ tokens: [{ name: " ops ", token: A }] }), [
    { name: "ops", token: A },
  ]);
});

test("parseAdminTokens: refuses bad shapes, short, placeholder, example and repeated tokens", () => {
  rejects(null, /"tokens" array/);
  rejects({ tokens: [] }, /at least one/);
  rejects({ tokens: [{ name: "ops", token: "short" }] }, /at least 32/);
  rejects({ tokens: [{ name: "", token: A }] }, /non-empty/);
  rejects({ tokens: [{ name: "ops", token: "replace-with-openssl-rand-hex-32" }] }, /placeholder/);
  rejects({ tokens: [{ name: "ops", token: EXAMPLE_TOKENS[0] }] }, /at least 32 characters/);
  rejects({ tokens: [{ name: "ops", token: "has white space 0123456789abcdef" }] }, /whitespace/);
  rejects(
    {
      tokens: [
        { name: "a", token: A },
        { name: "b", token: A },
      ],
    },
    /tokens\[1\] repeats/,
  );
});

test("error messages never contain a token", () => {
  const secret = "replace-with-secret-0123456789abcdef";
  assert.throws(
    () => parseAdminTokens({ tokens: [{ name: "ops", token: secret }] }),
    (err: Error) => !err.message.includes(secret),
  );
});

test("assertDistinctDigests: a probe or stored digest refuses without the token", () => {
  // SHA-256 of A and B, from `printf %s <token> | sha256sum`.
  const digestA = createHash("sha256").update(A).digest("hex");
  const digestB = createHash("sha256").update(B).digest("hex");
  const admin = [{ name: "ops", token: A }];
  assertDistinctDigests(admin, new Set([digestB]), new Set([digestB]));
  const refuses = (probe: Set<string>, stored: Set<string>, text: string): void => {
    assert.throws(
      () => assertDistinctDigests(admin, probe, stored),
      (err: Error) =>
        err instanceof TokensError && err.message === text && !err.message.includes(A),
    );
  };
  refuses(
    new Set([digestA]),
    new Set([digestA]),
    "admin tokens[0] is also a probe token: use a separate token",
  );
  refuses(new Set(), new Set([digestA]), "admin tokens[0] repeats a stored token");
});

test("parseAdminTokens: the admin minimum is 32 characters, probe tokens keep 16", () => {
  const short = "a".repeat(31);
  assert.throws(
    () => parseAdminTokens({ tokens: [{ name: "ops", token: short }] }),
    (error: unknown) =>
      error instanceof TokensError &&
      error.message.includes("tokens[0]") &&
      error.message.includes("at least 32 characters") &&
      !error.message.includes(short),
  );
  assert.deepEqual(parseAdminTokens({ tokens: [{ name: "ops", token: "b".repeat(32) }] }), [
    { name: "ops", token: "b".repeat(32) },
  ]);
  assert.deepEqual(parseTokens({ tokens: [{ location: "eu", token: "c".repeat(16) }] }), [
    { location: "eu", token: "c".repeat(16) },
  ]);
});

test("token length counts UTF-16 code units at every minimum", () => {
  // Each emoji is 2 UTF-16 code units but 1 code point.
  const cases = [
    {
      site: "admin",
      accept: `${"a".repeat(16)}${"😀".repeat(8)}`,
      refuse: `${"a".repeat(15)}${"😀".repeat(8)}`,
      units: 32,
    },
    {
      site: "probe",
      accept: `${"b".repeat(8)}${"😀".repeat(4)}`,
      refuse: `${"b".repeat(7)}${"😀".repeat(4)}`,
      units: 16,
    },
  ];
  const parse = (site: string, token: string): unknown =>
    site === "admin"
      ? parseAdminTokens({ tokens: [{ name: "ops", token }] })
      : parseTokens({ tokens: [{ location: "eu", token }] });
  for (const { site, accept, refuse, units } of cases) {
    assert.equal(accept.length, units, site);
    assert.equal(refuse.length, units - 1, site);
    assert.doesNotThrow(() => parse(site, accept), site);
    assert.throws(
      () => parse(site, refuse),
      (e: unknown) =>
        e instanceof TokensError && e.message.includes(`at least ${units} characters`),
      site,
    );
  }
});
