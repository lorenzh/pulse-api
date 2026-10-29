import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate, parseTokens, TokensError } from "./tokens.ts";

const A = "token-a-0123456789abcdef";
const B = "token-b-0123456789abcdef";
const tokens = [
  { location: "east", token: A },
  { location: "west", token: B },
];

function rejects(data: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseTokens(data),
    (err: unknown) => err instanceof TokensError && pattern.test(err.message),
  );
}

test("parseTokens: accepts entries, trims location, allows several tokens per location", () => {
  const parsed = parseTokens({
    tokens: [
      { location: " east ", token: A },
      { location: "east", token: B },
    ],
  });
  assert.deepEqual(
    parsed.map((t) => t.location),
    ["east", "east"],
  );
});

test("parseTokens: rejects bad files without printing tokens", () => {
  rejects(null, /"tokens" array/);
  rejects({}, /"tokens" array/);
  rejects({ tokens: [] }, /at least one entry/);
  rejects({ tokens: [5] }, /tokens\[0\] must be an object/);
  rejects({ tokens: [{ location: " ", token: A }] }, /tokens\[0\]\.location/);
  rejects({ tokens: [{ location: "x".repeat(65), token: A }] }, /at most 64/);
  rejects({ tokens: [{ location: "east", token: "short" }] }, /at least 16/);
  rejects({ tokens: [{ location: "east" }] }, /at least 16/);
  rejects(
    {
      tokens: [
        { location: "east", token: A },
        { location: "west", token: A },
      ],
    },
    /tokens\[1\] repeats the token of tokens\[0\]/,
  );
  rejects(
    { tokens: [{ location: "east", token: "replace-with-openssl-rand-hex-32" }] },
    /placeholder/,
  );
  try {
    parseTokens({ tokens: [{ location: "east", token: "short-secret" }] });
  } catch (err) {
    assert.ok(err instanceof Error && !err.message.includes("short-secret"));
  }
});

test("authenticate: valid bearer returns the location", () => {
  assert.equal(authenticate(tokens, `Bearer ${A}`), "east");
  assert.equal(authenticate(tokens, `bEaReR ${B}`), "west");
});

test("authenticate: strict header parsing", () => {
  for (const header of [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    `Bearer  ${A}`,
    ` Bearer ${A}`,
    `Bearer ${A} `,
    `Basic ${A}`,
    `Token ${A}`,
    A,
    "Bearer wrong",
    `Bearer ${A}x`,
  ]) {
    assert.equal(authenticate(tokens, header), undefined, String(header));
  }
});
