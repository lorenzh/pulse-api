import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Doc sentences that once contradicted the code. The behaviour itself is tested in
// service.locations.test.ts (rebuilt at start) and service.idempotent.test.ts (unique key).
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("troubleshooting: a restart keeps a location reporting while its stored result is recent", () => {
  const doc = read("docs/troubleshooting.md");
  assert.doesNotMatch(doc, /After an API restart a location is `silent` until its probe posts/);
  assert.match(
    doc,
    /After an API restart each location counts as seen at the timestamp of its newest stored result/,
  );
});

test("operation: first reads after a restart come from uptime_daily, not a 0.4 s window scan", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /takes about 0\.4 s/);
  assert.match(doc, /uptime_daily/);
});

test("bench README: the api no longer stores a repeated result twice", () => {
  assert.doesNotMatch(read("bench/README.md"), /results have no unique key/);
});
