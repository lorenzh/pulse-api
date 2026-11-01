import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The Compose setups live in pulse-deploy. This repository ships no runnable stack.
const path = (name: string): URL => new URL(`../${name}`, import.meta.url);

test("the repository ships no compose stack", () => {
  const removed = [
    "compose.yaml",
    "compose.e2e.yaml",
    "compose",
    ".env.example",
    "scripts/compose-e2e.sh",
    "scripts/outage-history.sh",
  ];
  assert.deepEqual(
    removed.filter((name) => existsSync(path(name))),
    [],
  );
});

test("ci has no compose-e2e job and no compose validation in docker", () => {
  const ci = readFileSync(path(".github/workflows/ci.yml"), "utf8");
  const jobs = [...ci.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(jobs, ["push", "check", "bench-selftest", "docker", "release"]);
  assert.doesNotMatch(ci, /\.env\.example/);
  assert.doesNotMatch(ci, /port override/i);
  assert.match(ci, /needs: \[check, docker, bench-selftest\]/);
});
