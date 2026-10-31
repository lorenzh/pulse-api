import { test } from "bun:test";
import assert from "node:assert/strict";
import { assertDistinctFromProbeTokens, parseAdminTokens } from "./admin-tokens.ts";
import { EXAMPLE_TOKENS, findByToken, TokensError } from "./tokens.ts";

const A = "admin-a-0123456789abcdef";
const B = "admin-b-0123456789abcdef";

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
  rejects({ tokens: [{ name: "ops", token: "short" }] }, /at least 16/);
  rejects({ tokens: [{ name: "", token: A }] }, /non-empty/);
  rejects({ tokens: [{ name: "ops", token: "replace-with-openssl-rand-hex-32" }] }, /placeholder/);
  rejects({ tokens: [{ name: "ops", token: EXAMPLE_TOKENS[0] }] }, /public example/);
  rejects({ tokens: [{ name: "ops", token: "has white space 0123456789" }] }, /whitespace/);
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
  const secret = "replace-with-secret-0123456789";
  assert.throws(
    () => parseAdminTokens({ tokens: [{ name: "ops", token: secret }] }),
    (err: Error) => !err.message.includes(secret),
  );
});

test("assertDistinctFromProbeTokens: an overlap is a startup error without the token", () => {
  const admin = [{ name: "ops", token: A }];
  assertDistinctFromProbeTokens(admin, [{ location: "eu", token: B }]);
  assert.throws(
    () => assertDistinctFromProbeTokens(admin, [{ location: "eu", token: A }]),
    (err: Error) =>
      err instanceof TokensError &&
      /also a probe token/.test(err.message) &&
      !err.message.includes(A),
  );
});

test("findByToken: needs a Bearer header with a configured token", () => {
  const a = { name: "a", token: A };
  const b = { name: "b", token: B };
  assert.equal(findByToken([a, b], `Bearer ${B}`), b);
  assert.equal(findByToken([a, b], `bearer ${A}`), a);
  assert.equal(findByToken([a], `Bearer ${B}`), undefined);
  assert.equal(findByToken([a], A), undefined);
  assert.equal(findByToken([a], undefined), undefined);
  assert.equal(findByToken([], `Bearer ${A}`), undefined);
});
