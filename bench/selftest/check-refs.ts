// Self-test of the ref resolution: tag present, no tag, lookup error, pinned others.
import assert from "node:assert/strict";
import {
  checkoutMismatch,
  newestTag,
  parseBRefs,
  REPOS,
  type RepoName,
  refLines,
  resolveRefs,
  resolveShas,
  sameShaMismatch,
} from "../refs.ts";

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
// --b-ref overrides only B of one repository, and only together with --others-ref.
const bRefs = parseBRefs(["status=x"], "main");
const overridden = await resolveRefs(
  { a: "abc", b: "def", othersRef: "main", bRefs },
  baseline,
  broken,
);
assert.equal(overridden.a.status, "main");
assert.equal(overridden.b.status, "x");
for (const name of ["probe", "notify", "contract", "kit", "config"] as const) {
  assert.equal(overridden.a[name], "main");
  assert.equal(overridden.b[name], "main");
}
assert.throws(() => parseBRefs(["api=x"], "main"), /not a non-api repository: api/);
assert.throws(() => parseBRefs(["nope=x"], "main"), /not a non-api repository: nope/);
assert.throws(() => parseBRefs(["status=x", "status=y"], "main"), /given twice/);
assert.throws(() => parseBRefs(["status=x"], undefined), /--b-ref needs --others-ref/);
assert.throws(() => parseBRefs(["status"], "main"), /needs <repo>=<ref>/);
assert.deepEqual(parseBRefs([], undefined), {});

// The same-SHA rule and the checkout comparison, with literal SHAs.
const ONE = "1111111111111111111111111111111111111111";
const TWO = "2222222222222222222222222222222222222222";
const THREE = "3333333333333333333333333333333333333333";
const allOne = Object.fromEntries(REPOS.map((r) => [r, ONE])) as Record<RepoName, string>;
assert.equal(sameShaMismatch({ a: allOne, b: { ...allOne, kit: TWO } }, {}), "ref mismatch: kit b");
assert.equal(sameShaMismatch({ a: allOne, b: { ...allOne, kit: TWO } }, { kit: "x" }), undefined);
assert.equal(sameShaMismatch({ a: allOne, b: { ...allOne, api: TWO } }, {}), undefined);
assert.equal(sameShaMismatch({ a: allOne, b: allOne }, {}), undefined);
assert.equal(checkoutMismatch("kit", "a", ONE, `${THREE}\n`), "ref mismatch: kit a");
assert.equal(checkoutMismatch("notify", "b", ONE, THREE), "ref mismatch: notify b");
assert.equal(checkoutMismatch("kit", "a", ONE, `${ONE}\n`), undefined);

// A `main` that moves after the first resolution never changes a resolved SHA.
const moves = new Map<RepoName, number>();
const moving = async (name: RepoName, ref: string): Promise<string> => {
  if (ref !== "main") return TWO;
  const count = (moves.get(name) ?? 0) + 1;
  moves.set(name, count);
  return count === 1 ? ONE : THREE;
};
const shas = await resolveShas(pinned, moving);
for (const name of REPOS.filter((r) => r !== "api")) {
  assert.equal(shas.a[name], ONE);
  assert.equal(shas.b[name], ONE);
}
assert.equal(shas.a.api, TWO);
assert.equal(sameShaMismatch(shas, {}), undefined);
assert.equal(refLines(shas)[5], `ref kit a=${ONE} b=${ONE}`);
assert.equal(refLines(shas)[0], `ref api a=${TWO} b=${TWO}`);
await assert.rejects(
  resolveShas(pinned, async () => "main"),
  /not a full SHA/,
);
console.log("check-refs: ok");
