import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, parseLogLevel } from "./log.ts";

test("log lines are JSON with ISO time and level, and the level filters", () => {
  const lines: string[] = [];
  const log = createLogger({
    level: "info",
    now: () => Date.parse("2026-10-28T12:00:00Z"),
    write: (line) => lines.push(line),
  });
  log.debug("hidden");
  log.warn("careful", { port: 1 });
  assert.deepEqual(
    lines.map((l) => JSON.parse(l)),
    [{ time: "2026-10-28T12:00:00.000Z", level: "warn", msg: "careful", port: 1 }],
  );
});

test("parseLogLevel defaults to info and rejects unknown values", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(" debug "), "debug");
  assert.throws(() => parseLogLevel("loud"), /PULSE_LOG_LEVEL must be one of/);
});
