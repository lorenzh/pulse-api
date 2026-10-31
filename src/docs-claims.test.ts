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

test("bench README: the api no longer stores a repeated result twice", () => {
  assert.doesNotMatch(read("bench/README.md"), /results have no unique key/);
});

test("operation: the database runs in WAL mode and has a backup command", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /does not set a journal mode/);
  assert.doesNotMatch(doc, /the API has no backup command/);
  assert.match(doc, /bun run backup/);
  assert.match(doc, /pulse\.db-wal/);
});

test("operation: the backup docs name the temp file that only SIGKILL or a crash leaves", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /so a failed run leaves no partial file/);
  assert.match(
    doc,
    /A run ended by `SIGKILL`, a crash or a power loss can leave `\.<name>\.tmp-<pid>` behind/,
  );
  assert.match(doc, /interrupted; no backup written and the temp file is removed/);
});
