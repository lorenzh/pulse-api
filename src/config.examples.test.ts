import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigError, loadAdminTokens, loadConfig, loadTokens, parseConfig } from "./config.ts";

const CHECKS_EXAMPLE = new URL("../checks.example.json", import.meta.url).pathname;
const TOKENS_EXAMPLE = new URL("../tokens.example.json", import.meta.url).pathname;

test("checks.example.json is refused while its heartbeat secret is the placeholder", () => {
  assert.throws(
    () => loadConfig(CHECKS_EXAMPLE),
    (err: unknown) =>
      err instanceof ConfigError &&
      err.message.includes("checks[6].secret still has the example placeholder secret") &&
      !err.message.includes("replace-with-a-random-secret"),
  );
});

test("checks.example.json loads through the config parser once the secret is replaced", () => {
  const data: unknown = JSON.parse(readFileSync(CHECKS_EXAMPLE, "utf8"));
  assert.ok(typeof data === "object" && data !== null && "checks" in data);
  assert.ok(Array.isArray(data.checks));
  const checks: unknown[] = data.checks;
  const config = parseConfig({
    ...data,
    checks: checks.map((c) =>
      typeof c === "object" && c !== null && "secret" in c
        ? { ...c, secret: "a-real-secret-0123456789" }
        : c,
    ),
  });
  assert.deepEqual(
    config.checks.map((c) => c.id),
    [
      "example",
      "example-api",
      "example-cert",
      "example-tcp",
      "example-dns",
      "example-domain",
      "nightly-backup",
    ],
  );
  assert.equal(config.maintenance.length, 1);
  assert.deepEqual(
    config.components.map((c) => c.id),
    ["example", "backend"],
  );
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
