import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the update checks of scripts/compose-e2e.sh against a fake `docker` that prints a
// fixture channel file, so the key matching is tested without a Compose stack.
const script = readFileSync(join(import.meta.dir, "..", "scripts", "compose-e2e.sh"), "utf8");

function section(from: string, to: string): string {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`section ${from} not found`);
  return script.slice(start, end);
}

function lineAfter(marker: string, prefix: string): string {
  const lines = script.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  const found = lines.slice(at + 1).find((line) => line.startsWith(prefix));
  if (at < 0 || found === undefined) throw new Error(`no ${prefix} after ${marker}`);
  return found;
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compose-e2e-keys-"));
  const docker = join(dir, "docker");
  writeFileSync(docker, '#!/bin/sh\ncat "$FIXTURE"\n');
  chmodSync(docker, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCheck(keys: string[], check: string): number {
  const fixture = join(dir, "channel.jsonl");
  writeFileSync(fixture, keys.map((key) => `{"key":"${key}","event":"update"}\n`).join(""));
  const helpers = section("manual_count() {", "metric_is() {");
  const body = `fail() { exit 1; }\nwait_for() { shift 2; "$@"; }\nmanual_id=7\n${helpers}\n${check}\n`;
  const result = spawnSync("/bin/bash", ["-c", body], {
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, FIXTURE: fixture },
  });
  return result.status ?? -1;
}

describe("compose e2e manual update key", () => {
  const waitLine = lineAfter('"status":"identified"', "wait_for ");

  test("the wait accepts a stable update key", () => {
    expect(
      runCheck(["manual:7:opened", "manual:7:update:944060dad462720cba7f4ef5321c14ae"], waitLine),
    ).toBe(0);
  });

  test("the wait accepts the legacy update key", () => {
    expect(runCheck(["manual:7:opened", "manual:7:update:1"], waitLine)).toBe(0);
  });

  test("the wait ignores the update of another incident", () => {
    expect(runCheck(["manual:71:update:1"], waitLine)).toBe(1);
  });

  test("the restart check accepts one stable update key and rejects a second one", () => {
    const restart = section("docker compose restart notify", 'echo "ok: a notify restart');
    const after = restart.slice(restart.indexOf("for key in"));
    const stable = "manual:7:update:944060dad462720cba7f4ef5321c14ae";
    expect(runCheck(["manual:7:opened", stable, "manual:7:resolved"], after)).toBe(0);
    expect(runCheck(["manual:7:opened", stable, stable, "manual:7:resolved"], after)).toBe(1);
  });
});
