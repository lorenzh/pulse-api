import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, parseConfig } from "./config.ts";

const check = { id: "a", name: "A", url: "http://localhost:1/", intervalMs: 1000 };
const win = {
  checkId: "a",
  start: "2030-01-01T02:00:00Z",
  end: "2030-01-01T04:00:00+01:00",
  note: "Upgrade",
};

test("config: missing maintenance key means no windows", () => {
  assert.deepEqual(parseConfig({ checks: [check] }), {
    checks: [{ ...check, retries: 0, retryDelayMs: 1000 }],
    maintenance: [],
  });
});

test("config: parses windows to epoch ms", () => {
  const { maintenance } = parseConfig({ checks: [check], maintenance: [win] });
  assert.deepEqual(maintenance, [
    {
      checkId: "a",
      start: Date.parse("2030-01-01T02:00:00Z"),
      end: Date.parse("2030-01-01T03:00:00Z"),
      note: "Upgrade",
    },
  ]);
});

test("config: rejects invalid windows", () => {
  const bad: unknown[] = [
    "x",
    [null],
    [{ ...win, start: "not a date" }],
    [{ ...win, start: "2030-13-45T00:00:00Z" }],
    [{ ...win, start: "2030-01-01T02:00:00" }],
    [{ ...win, end: "2030-01-01T04:00:00" }],
    [{ ...win, start: 1893459600000 }],
    [{ ...win, checkId: "zzz" }],
    [{ ...win, end: win.start }],
    [{ ...win, end: "2029-01-01T00:00:00Z" }],
    [{ ...win, note: "" }],
    [{ ...win, note: "  " }],
    [{ ...win, note: undefined }],
  ];
  for (const m of bad) {
    assert.throws(
      () => parseConfig({ checks: [check], maintenance: m }),
      ConfigError,
      JSON.stringify(m),
    );
  }
});

test("config: loadConfig reads a file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pulse-cfg-")), "checks.json");
  writeFileSync(path, JSON.stringify({ checks: [check], maintenance: [win] }));
  assert.equal(loadConfig(path).maintenance.length, 1);
  assert.throws(() => loadConfig(`${path}.missing`), ConfigError);
});
