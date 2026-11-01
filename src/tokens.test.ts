import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { authenticate, EXAMPLE_TOKENS, parseTokens, sha256Hex, TokensError } from "./tokens.ts";

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

test("parseTokens: rejects example tokens and whitespace without printing the token", () => {
  for (const token of EXAMPLE_TOKENS) {
    rejects({ tokens: [{ location: "east", token }] }, /tokens\[0\] \(location "east"\)/);
  }
  for (const bad of [`${A} x`, `${A}\t`, `${A}\n`, ` ${A}`, `${A} `, `${A}\tz`]) {
    assert.throws(
      () => parseTokens({ tokens: [{ location: "east", token: bad }] }),
      (err: unknown) =>
        err instanceof TokensError && /whitespace/.test(err.message) && !err.message.includes(A),
    );
  }
  for (const token of EXAMPLE_TOKENS) {
    assert.throws(
      () => parseTokens({ tokens: [{ location: "east", token }] }),
      (err: unknown) => err instanceof TokensError && !err.message.includes(token),
    );
  }
});

test("docs and .env.example only show tokens that the API accepts", () => {
  const files = [
    ".env.example",
    ...readdirSync("docs")
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/${f}`),
  ];
  const patterns = [
    /example-token-[\w-]+/g,
    /Bearer ([A-Za-z0-9_-]{16,})/g,
    /PULSE_PROBE_TOKEN=([^\s"']+)/g,
  ];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const token = m[1] ?? m[0];
        // Placeholders and shell variables are not literal tokens.
        if (/^(replace-with-|\$|<)/.test(token)) continue;
        // Every literal token shown must work, so a copied example starts the API.
        assert.doesNotThrow(
          () => parseTokens({ tokens: [{ location: "x", token }] }),
          `${file} shows a token the API rejects`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
});

test("sha256Hex: lower-case hex SHA-256 of the UTF-8 bytes", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha256Hex("é"), "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
});
