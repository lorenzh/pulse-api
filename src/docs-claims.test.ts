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

test("operation: the database runs in WAL mode and has a backup command", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /does not set a journal mode/);
  assert.doesNotMatch(doc, /the API has no backup command/);
  assert.match(doc, /bun run backup/);
  assert.match(doc, /pulse\.db-wal/);
});

test("operation: the backup docs name the temp directory that only SIGKILL or a crash leaves", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /so a failed run leaves no partial file/);
  assert.match(
    doc,
    /A run ended by `SIGKILL`, a crash or a power loss can leave `\.<name>\.tmp-XXXXXX` behind/,
  );
  assert.match(doc, /interrupted; no backup written and the temp directory is removed/);
});

test("operation: the backup is a VACUUM INTO copy without free pages, not a copy held in memory", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /memory for one copy of the file/);
  assert.doesNotMatch(doc, /it keeps free pages/);
  assert.match(doc, /without free pages, so deleted rows are not in it/);
});

test("configuration: both token files are imported once and then ignored", () => {
  const doc = read("docs/configuration.md");
  assert.match(doc, /Both token files are imported once and then ignored/);
  assert.doesNotMatch(doc, /a change to the environment or to the tokens files needs a restart/);
  assert.match(doc, /ignored: tokens are stored in the database/);
});

test("rest-api: tokens, scopes, overlap, paging and export are documented", () => {
  const doc = read("docs/rest-api.md");
  for (const route of ["POST /admin/tokens", "/rotate", "/revoke", "GET /admin/audit/export"]) {
    assert.ok(doc.includes(route), route);
  }
  assert.match(doc, /valid for 10 minutes/);
  assert.match(doc, /application\/x-ndjson; charset=utf-8/);
  assert.match(doc, /`limit` \(1 to 1000, default 100\)/);
  assert.match(doc, /`at` is not strictly ordered by `id`/);
  assert.doesNotMatch(doc, /A missing, wrong or probe token answers `401`/);
});

test("operation: rotation overlap, lockout restore, audit growth, EXTRA and orphan temp files", () => {
  const doc = read("docs/operation.md");
  assert.doesNotMatch(doc, /Tokens are read at start\. Restart the API to rotate/);
  assert.match(doc, /PULSE_PROBE_TOKEN/);
  assert.match(doc, /restore a \[backup\]/);
  assert.match(doc, /The table only grows/);
  assert.match(doc, /`synchronous = EXTRA`/);
  assert.match(doc, /Delete it while the API is stopped/);
  assert.match(doc, /Rotate them once after the upgrade/);
});
