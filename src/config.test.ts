import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadChecks, parseChecks } from "./config.ts";

const ok = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };

const withRetryDefaults = <T extends object>(c: T) => ({ ...c, retries: 0, retryDelayMs: 1000 });

test("config: valid checks, timeoutMs optional", () => {
  const checks = parseChecks({ checks: [ok, { ...ok, id: "b", timeoutMs: 500 }] });
  assert.deepEqual(checks, [
    withRetryDefaults(ok),
    withRetryDefaults({ ...ok, id: "b", timeoutMs: 500 }),
  ]);
});

test("config: rejects invalid input", () => {
  const bad: unknown[] = [
    null,
    {},
    { checks: [null] },
    { checks: [{ ...ok, id: undefined }] },
    { checks: [{ ...ok, name: "" }] },
    { checks: [{ ...ok, url: "nope" }] },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
    { checks: [{ ...ok, url: "ftp://x/" }] },
    { checks: [{ ...ok, intervalMs: 0 }] },
    { checks: [{ ...ok, intervalMs: 1.5 }] },
    { checks: [{ ...ok, intervalMs: "1000" }] },
    { checks: [{ ...ok, timeoutMs: -1 }] },
    { checks: [ok, ok] },
  ];
  for (const b of bad) assert.throws(() => parseChecks(b), ConfigError, JSON.stringify(b));
});

test("config: duplicate id message", () => {
  assert.throws(() => parseChecks({ checks: [ok, ok] }), /duplicate check id "a"/);
});

test("config: loadChecks reads files and reports errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-cfg-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ checks: [ok] }));
  assert.deepEqual(loadChecks(good), [withRetryDefaults(ok)]);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  assert.throws(() => loadChecks(broken), /not valid JSON/);
  assert.throws(() => loadChecks(join(dir, "missing.json")), /cannot read/);
});

test("config: retries and retryDelayMs defaults and explicit values", () => {
  const [a] = parseChecks({ checks: [ok] });
  assert.equal((a as { retries: number }).retries, 0);
  assert.equal((a as { retryDelayMs: number }).retryDelayMs, 1000);
  const [b] = parseChecks({
    checks: [{ ...ok, intervalMs: 60000, retries: 2, retryDelayMs: 500 }],
  });
  assert.deepEqual(
    { r: (b as { retries: number }).retries, d: (b as { retryDelayMs: number }).retryDelayMs },
    { r: 2, d: 500 },
  );
  assert.equal(
    (
      parseChecks({ checks: [{ ...ok, retries: 0, retryDelayMs: 0 }] })[0] as {
        retryDelayMs: number;
      }
    ).retryDelayMs,
    0,
  );
});

test("config: rejects invalid retries and retryDelayMs", () => {
  const big = { ...ok, intervalMs: 10_000_000 };
  const bad = [
    { ...big, retries: -1 },
    { ...big, retries: 1.5 },
    { ...big, retries: 11 },
    { ...big, retries: "1" },
    { ...big, retries: 1, retryDelayMs: -1 },
    { ...big, retries: 1, retryDelayMs: 0.5 },
    { ...big, retries: 1, retryDelayMs: 60001 },
  ];
  for (const b of bad)
    assert.throws(() => parseChecks({ checks: [b] }), ConfigError, JSON.stringify(b));
});

test("config: rejects a worst case longer than the interval", () => {
  // (1+1)*5000 + 1*1000 = 11000 with the default timeout and delay
  assert.throws(
    () => parseChecks({ checks: [{ ...ok, intervalMs: 10999, retries: 1 }] }),
    ConfigError,
  );
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...ok, intervalMs: 11000, retries: 1 }] }));
  // explicit timeout: (2+1)*100 + 2*50 = 400
  const c = { ...ok, timeoutMs: 100, retries: 2, retryDelayMs: 50 };
  assert.throws(() => parseChecks({ checks: [{ ...c, intervalMs: 399 }] }), ConfigError);
  assert.doesNotThrow(() => parseChecks({ checks: [{ ...c, intervalMs: 400 }] }));
});
