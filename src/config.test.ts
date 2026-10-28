import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadChecks, parseChecks } from "./config.ts";

const ok = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };

test("config: valid checks, timeoutMs optional", () => {
  const checks = parseChecks({ checks: [ok, { ...ok, id: "b", timeoutMs: 500 }] });
  assert.deepEqual(checks, [ok, { ...ok, id: "b", timeoutMs: 500 }]);
});

test("config: rejects invalid input", () => {
  const bad: unknown[] = [
    null,
    {},
    { checks: [null] },
    { checks: [{ ...ok, id: undefined }] },
    { checks: [{ ...ok, name: "" }] },
    { checks: [{ ...ok, url: "nope" }] },
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
  assert.deepEqual(loadChecks(good), [ok]);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  assert.throws(() => loadChecks(broken), /not valid JSON/);
  assert.throws(() => loadChecks(join(dir, "missing.json")), /cannot read/);
});
