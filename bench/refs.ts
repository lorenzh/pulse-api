// Ref resolution per repository and side. Pure except for the injected `lsRemoteTags` and
// `containsCommit`, which runs git.
import { runCommand } from "./measure.ts";

export const REPOS = ["api", "probe", "status", "notify", "contract", "kit", "config"] as const;
export type RepoName = (typeof REPOS)[number];
export type Baseline = Record<string, string>;

export interface RefOptions {
  a: string;
  b: string;
  othersRef?: string;
  /** B-side overrides from `--b-ref`; only together with `othersRef`. */
  bRefs?: Partial<Record<RepoName, string>>;
}

export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * Parses the values of the repeatable `--b-ref <repo>=<ref>`. Refused: a repository other than the
 * non-api ones, a repeated repository, an empty ref, and any `--b-ref` without `--others-ref`.
 */
export function parseBRefs(
  values: readonly string[],
  othersRef: string | undefined,
): Partial<Record<RepoName, string>> {
  const result: Partial<Record<RepoName, string>> = {};
  if (values.length > 0 && othersRef === undefined) {
    throw new UsageError("--b-ref needs --others-ref");
  }
  for (const value of values) {
    const at = value.indexOf("=");
    const repo = at < 0 ? value : value.slice(0, at);
    const ref = at < 0 ? "" : value.slice(at + 1);
    const name = REPOS.find((r) => r === repo);
    if (name === undefined || name === "api") {
      throw new UsageError(`--b-ref: not a non-api repository: ${repo}`);
    }
    if (ref === "") throw new UsageError(`--b-ref ${repo}: needs <repo>=<ref>`);
    if (result[name] !== undefined) throw new UsageError(`--b-ref ${repo}: given twice`);
    result[name] = ref;
  }
  return result;
}

export interface SideRefs {
  a: Record<RepoName, string>;
  b: Record<RepoName, string>;
}

export function repoUrl(name: string): string {
  return `https://github.com/lorenzh/pulse-${name}.git`;
}

/** Newest `v*` tag from `git ls-remote --tags --sort=-v:refname` output, or undefined. */
export function newestTag(lsRemoteOutput: string): string | undefined {
  for (const line of lsRemoteOutput.split("\n")) {
    const ref = line.split("\t")[1];
    const match = ref === undefined ? null : /^refs\/tags\/(v.+?)(\^\{\})?$/.exec(ref.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** The A ref of a repository that is not pinned: the newest `v*` tag, else the baseline SHA. */
export async function baselineRef(
  name: RepoName,
  baseline: Baseline,
  lsRemoteTags: (url: string) => Promise<string>,
): Promise<string> {
  // A failing lookup throws: it fails the run instead of silently using the fallback.
  const tag = newestTag(await lsRemoteTags(repoUrl(name)));
  if (tag !== undefined) return tag;
  const sha = baseline[name];
  if (sha === undefined) throw new Error(`no tag and no baseline.json entry for ${name}`);
  return sha;
}

export async function resolveRefs(
  options: RefOptions,
  baseline: Baseline,
  lsRemoteTags: (url: string) => Promise<string>,
): Promise<SideRefs> {
  const a: Partial<Record<RepoName, string>> = {};
  const b: Partial<Record<RepoName, string>> = {};
  for (const name of REPOS) {
    if (name === "api") {
      a[name] =
        options.a === "baseline" ? await baselineRef(name, baseline, lsRemoteTags) : options.a;
      b[name] = options.b;
    } else if (options.othersRef !== undefined) {
      a[name] = options.othersRef;
      b[name] = options.bRefs?.[name] ?? options.othersRef;
    } else {
      a[name] = await baselineRef(name, baseline, lsRemoteTags);
      b[name] = "main";
    }
  }
  return { a: complete(a), b: complete(b) };
}

function complete(refs: Partial<Record<RepoName, string>>): Record<RepoName, string> {
  const result = {} as Record<RepoName, string>;
  for (const name of REPOS) {
    const ref = refs[name];
    if (ref === undefined) throw new Error(`no ref for ${name}`);
    result[name] = ref;
  }
  return result;
}

/**
 * Resolves every ref of both sides to a full commit SHA, once per repository and ref, so that A
 * and B of one ref get the same SHA and a ref that moves later never changes a checkout.
 */
export async function resolveShas(
  refs: SideRefs,
  resolve: (name: RepoName, ref: string) => Promise<string>,
): Promise<SideRefs> {
  const cache = new Map<string, string>();
  const one = async (name: RepoName, ref: string): Promise<string> => {
    const key = `${name}\n${ref}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const sha = await resolve(name, ref);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`ref ${name} ${ref}: not a full SHA`);
    cache.set(key, sha);
    return sha;
  };
  const a: Partial<Record<RepoName, string>> = {};
  const b: Partial<Record<RepoName, string>> = {};
  for (const name of REPOS) {
    a[name] = await one(name, refs.a[name]);
    b[name] = await one(name, refs.b[name]);
  }
  return { a: complete(a), b: complete(b) };
}

/**
 * The same-SHA rule of a controlled comparison: every repository but the api and the `--b-ref`
 * ones runs one SHA on both sides. Returns the error text, or undefined.
 */
export function sameShaMismatch(
  shas: SideRefs,
  bRefs: Partial<Record<RepoName, string>>,
): string | undefined {
  for (const name of REPOS) {
    if (name === "api" || bRefs[name] !== undefined) continue;
    if (shas.a[name] !== shas.b[name]) return `ref mismatch: ${name} b`;
  }
  return undefined;
}

/** The check after a checkout: the worktree HEAD must be the resolved SHA. */
export function checkoutMismatch(
  name: RepoName,
  side: "a" | "b",
  resolved: string,
  head: string,
): string | undefined {
  return head.trim() === resolved ? undefined : `ref mismatch: ${name} ${side}`;
}

/** One log line per repository: `ref <repo> a=<sha> b=<sha>`. */
export function refLines(shas: SideRefs): string[] {
  return REPOS.map((name) => `ref ${name} a=${shas.a[name]} b=${shas.b[name]}`);
}

/**
 * True when the checkout at `dir` contains `commit` (its HEAD descends from it). Fetches the commit
 * first when the clone lacks it: a ref older than the commit never brought it in.
 */
export async function containsCommit(dir: string, commit: string): Promise<boolean> {
  const present = await runCommand("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: dir });
  if (present.code !== 0) {
    const fetched = await runCommand("git", ["fetch", "-q", "origin", commit], { cwd: dir });
    if (fetched.code !== 0)
      throw new Error(`cannot fetch ${commit} in ${dir}: ${fetched.stderr.trim()}`);
  }
  const result = await runCommand("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd: dir,
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${commit} in ${dir}: ${result.stderr.trim()}`);
}
