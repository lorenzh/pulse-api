import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAdminTokens, loadChecks, loadConfig, loadTokens } from "./config.ts";

const CHECKS_EXAMPLE = new URL("../checks.example.json", import.meta.url).pathname;
const TOKENS_EXAMPLE = new URL("../tokens.example.json", import.meta.url).pathname;

test("checks.example.json loads through the config parser", () => {
  const config = loadConfig(CHECKS_EXAMPLE);
  assert.deepEqual(
    config.checks.map((c) => c.id),
    ["example", "example-api", "example-cert", "nightly-backup"],
  );
  assert.equal(config.maintenance.length, 1);
  assert.deepEqual(
    config.components.map((c) => c.id),
    ["example", "backend"],
  );
  assert.equal(loadChecks(CHECKS_EXAMPLE).length, 4);
});

test("tokens.example.json is well formed and its placeholder token is rejected", () => {
  assert.throws(() => loadTokens(TOKENS_EXAMPLE), {
    name: "TokensError",
    message: 'tokens[0] (location "east") still has the example placeholder token',
  });
});

test("admin-tokens.example.json is well formed and its placeholder token is rejected", () => {
  const example = new URL("../admin-tokens.example.json", import.meta.url).pathname;
  assert.throws(() => loadAdminTokens(example), {
    name: "TokensError",
    message: /still has the example placeholder token/,
  });
});
