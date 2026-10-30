// Self-test of the ref resolution: tag present, no tag, lookup error, pinned others.
import assert from "node:assert/strict";
import { newestTag, REPOS, resolveRefs } from "../refs.ts";

const baseline = Object.fromEntries(REPOS.map((r) => [r, `${r}-sha`]));
const withTag = async (): Promise<string> =>
  "aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.2.0^{}\nccc\trefs/tags/v1.1.0\n";
const noTag = async (): Promise<string> => "";
const broken = async (): Promise<string> => {
  throw new Error("network down");
};

assert.equal(newestTag("aaa\trefs/tags/v2.0.0^{}\nbbb\trefs/tags/v1.0.0\n"), "v2.0.0");
assert.equal(newestTag(""), undefined);

const tagged = await resolveRefs({ a: "baseline", b: "main" }, baseline, withTag);
assert.equal(tagged.a.probe, "v1.2.0");
assert.equal(tagged.a.api, "v1.2.0");
assert.equal(tagged.b.probe, "main");
assert.equal(tagged.b.api, "main");

const fallback = await resolveRefs({ a: "baseline", b: "main" }, baseline, noTag);
assert.equal(fallback.a.kit, "kit-sha");
assert.equal(fallback.a.api, "api-sha");

const explicit = await resolveRefs({ a: "abc", b: "def" }, baseline, noTag);
assert.equal(explicit.a.api, "abc");
assert.equal(explicit.b.api, "def");

const pinned = await resolveRefs({ a: "abc", b: "abc", othersRef: "main" }, baseline, broken);
for (const name of REPOS.filter((r) => r !== "api")) {
  assert.equal(pinned.a[name], "main");
  assert.equal(pinned.b[name], "main");
}

await assert.rejects(resolveRefs({ a: "baseline", b: "main" }, baseline, broken), /network down/);
await assert.rejects(
  resolveRefs({ a: "baseline", b: "main" }, {}, noTag),
  /no tag and no baseline/,
);
console.log("check-refs: ok");
