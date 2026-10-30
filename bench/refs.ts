// Ref resolution per repository and side. Pure except for the injected `lsRemoteTags`.
export const REPOS = ["api", "probe", "status", "notify", "contract", "kit", "config"] as const;
export type RepoName = (typeof REPOS)[number];
export type Baseline = Record<string, string>;

export interface RefOptions {
  a: string;
  b: string;
  othersRef?: string;
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
      b[name] = options.othersRef;
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
