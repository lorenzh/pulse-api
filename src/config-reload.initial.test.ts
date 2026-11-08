// readInitialConfig on real files: a valid file loads; bad JSON, a missing file and the example are refused with safe texts.
import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { nodeConfigFs } from "./config-fs.ts";
import { readInitialConfig } from "./config-reload.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-initial-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a valid checks file loads its checks, windows, components and revision", () => {
  const path = join(tempDir(), "checks.json");
  writeFileSync(
    path,
    JSON.stringify({
      checks: [{ id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 }],
      maintenance: [
        {
          checkId: "a",
          start: "2030-01-01T02:00:00Z",
          end: "2030-01-01T04:00:00+01:00",
          note: "Upgrade",
        },
      ],
    }),
  );
  const read = readInitialConfig(nodeConfigFs, path);
  assert.ok(read.ok);
  const { config, revision } = read.initial;
  assert.deepEqual(config.checks, [
    {
      id: "a",
      name: "A",
      url: "http://localhost:1/",
      intervalMs: 1000,
      retries: 0,
      retryDelayMs: 1000,
    },
  ]);
  assert.deepEqual(
    config.maintenance.map((w) => [w.checkId, w.start, w.end]),
    [["a", 1893463200000, 1893466800000]],
  );
  assert.deepEqual(config.components, []);
  assert.match(revision, /^sha256-[0-9a-f]{64}$/);
});

test("a file that is not valid JSON is refused without quoting its content", () => {
  const dir = tempDir();
  for (const [name, text] of [
    ["broken.json", "{"],
    ["leaky.json", '{"checks":[{"headers":{"X":HSEC},"body":BSEC}]}'],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, text);
    const read = readInitialConfig(nodeConfigFs, path);
    assert.ok(!read.ok, name);
    assert.equal(read.state, "invalid", name);
    assert.equal(read.message, "checks file is not valid JSON", name);
    assert.ok(read.error instanceof ConfigError, name);
    assert.equal(read.error.message, `checks file ${path} is not valid JSON`, name);
    for (const t of [read.message, read.error.message]) {
      assert.ok(!t.includes("HSEC") && !t.includes("BSEC"), t);
    }
  }
});

test("a missing file is unreadable with the safe error code", () => {
  const path = join(tempDir(), "missing.json");
  const read = readInitialConfig(nodeConfigFs, path);
  assert.ok(!read.ok);
  assert.equal(read.state, "unreadable");
  assert.equal(read.message, "cannot read the file (ENOENT)");
  assert.ok(read.error instanceof ConfigError);
  assert.equal(read.error.message, `cannot read checks file ${path}: ENOENT`);
  assert.equal(read.stampKey, undefined);
});

test("checks.example.json is refused while its heartbeat secret is the placeholder", () => {
  const path = new URL("../checks.example.json", import.meta.url).pathname;
  const read = readInitialConfig(nodeConfigFs, path);
  assert.ok(!read.ok);
  assert.equal(read.state, "invalid");
  assert.equal(read.message, "checks[6].secret still has the example placeholder secret");
  assert.ok(!read.error.message.includes("replace-with-a-random-secret"));
});
