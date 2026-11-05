import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    secrets: new Map(),
    maintenance: [],
    components: [],
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
  const dir = mkdtempSync(join(tmpdir(), "pulse-cfg-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "checks.json");
  writeFileSync(path, JSON.stringify({ checks: [check], maintenance: [win] }));
  assert.equal(loadConfig(path).maintenance.length, 1);
  assert.throws(() => loadConfig(`${path}.missing`), ConfigError);
});

test("config: a window id loads, a window without one loads unchanged", () => {
  const { maintenance } = parseConfig({ checks: [check], maintenance: [{ ...win, id: "w" }, win] });
  assert.deepEqual(
    maintenance.map((w) => w.id),
    ["w", undefined],
  );
  assert.equal(Object.hasOwn(maintenance[1] ?? {}, "id"), false);
});

test("config: a duplicate or malformed window id is refused", () => {
  assert.throws(
    () =>
      parseConfig({
        checks: [check],
        maintenance: [
          { ...win, id: "w" },
          { ...win, id: "w" },
        ],
      }),
    { name: "ConfigError", message: 'maintenance[1].id: duplicate maintenance id "w"' },
  );
  for (const id of ["0", "Web", "-a", "", "a".repeat(65), 7]) {
    assert.throws(
      () => parseConfig({ checks: [check], maintenance: [{ ...win, id }] }),
      ConfigError,
      String(id),
    );
  }
});

test("config: a file note keeps no length cap", () => {
  const note = "n".repeat(600);
  const { maintenance } = parseConfig({ checks: [check], maintenance: [{ ...win, note }] });
  assert.equal(maintenance[0]?.note, note);
});
