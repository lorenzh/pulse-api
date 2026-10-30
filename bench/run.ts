// Entry point: bun bench/run.ts --a <ref> --b <ref> [--rounds n] [--others-ref <ref>] [--out <dir>]
// Interleaved A/B comparison of CPU time and memory per service. See bench/README.md.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Budgets,
  EMITTED_METRICS,
  isFailure,
  judge,
  missingBudgets,
  parseBudgets,
  type Row,
  renderTable,
} from "./compare.ts";
import { median, runChecked } from "./measure.ts";
import { type Baseline, REPOS, type RepoName, repoUrl, resolveRefs } from "./refs.ts";
import { buildImages, imageSizeMB, runStack, SERVICES, type SideDirs } from "./stack.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH_DIR, "..");
const WORK_ROOT = join(ROOT, ".bench");
const COMPOSE_FILE = join(BENCH_DIR, "compose.bench.yaml");
const BUILD_REPOS: readonly RepoName[] = ["contract", "kit"];

type Side = "a" | "b";
const SIDES: readonly Side[] = ["a", "b"];
type Samples = Record<string, Record<string, number[]>>;

interface Args {
  a: string;
  b: string;
  rounds: number;
  othersRef?: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined || value === "") {
      throw new Error(`bad argument near "${key ?? ""}"`);
    }
    values.set(key.slice(2), value);
  }
  for (const key of values.keys()) {
    if (!["a", "b", "rounds", "others-ref", "out"].includes(key)) {
      throw new Error(`unknown option --${key}`);
    }
  }
  const rounds = Number(values.get("rounds") ?? 5);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be an integer >= 1");
  const othersRef = values.get("others-ref");
  return {
    a: values.get("a") ?? "baseline",
    b: values.get("b") ?? "main",
    rounds,
    ...(othersRef === undefined ? {} : { othersRef }),
    out: resolve(values.get("out") ?? join(ROOT, "bench-out")),
  };
}

const log = (line: string): void => console.log(`[bench] ${line}`);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function lsRemoteTags(url: string): Promise<string> {
  const { stdout } = await runChecked("git", [
    "ls-remote",
    "--tags",
    "--sort=-v:refname",
    url,
    "v*",
  ]);
  return stdout;
}

/** Clone once, then add a worktree of `ref` and install its dependencies. */
async function checkout(name: RepoName, side: Side, ref: string): Promise<string> {
  const clone = join(WORK_ROOT, "repos", name);
  if (await Bun.file(join(clone, ".git", "HEAD")).exists()) {
    await runChecked("git", ["fetch", "origin", ref], { cwd: clone });
  } else {
    await mkdir(dirname(clone), { recursive: true });
    await runChecked("git", ["clone", "--filter=blob:none", "--no-checkout", repoUrl(name), clone]);
    await runChecked("git", ["fetch", "origin", ref], { cwd: clone });
  }
  const dir = join(WORK_ROOT, "work", side, name);
  await runChecked("rm", ["-rf", dir]);
  await runChecked("git", ["worktree", "prune"], { cwd: clone });
  await runChecked("git", ["worktree", "add", "--detach", dir, "FETCH_HEAD"], { cwd: clone });
  await runChecked("bun", ["install", "--frozen-lockfile"], { cwd: dir });
  return dir;
}

async function prepareSide(side: Side, refs: Record<RepoName, string>): Promise<SideDirs> {
  const work: Record<string, string> = {};
  for (const name of REPOS) {
    log(`checkout ${name} ${refs[name]} (${side})`);
    work[name] = await checkout(name, side, refs[name]);
  }
  const apiDir = work.api;
  if (apiDir === undefined) throw new Error("api worktree missing");
  const seedDb = join(WORK_ROOT, "seed", side, "pulse.db");
  await runChecked("rm", ["-rf", dirname(seedDb)]);
  await mkdir(dirname(seedDb), { recursive: true });
  await runChecked("bun", [join(BENCH_DIR, "seed.ts"), apiDir, seedDb]);
  const dirs: SideDirs = { side, work, seedDb };
  log(`build images (${side})`);
  await buildImages(dirs, COMPOSE_FILE, join(WORK_ROOT, "run", side));
  return dirs;
}

function add(samples: Samples, service: string, metric: string, value: number): void {
  const metrics = samples[service] ?? {};
  samples[service] = metrics;
  const values = metrics[metric] ?? [];
  metrics[metric] = values;
  values.push(value);
}

async function measureRepoScripts(dirs: SideDirs, samples: Samples): Promise<void> {
  for (const name of REPOS) {
    const cwd = dirs.work[name];
    if (cwd === undefined) throw new Error(`no worktree for ${name}`);
    const test = await runChecked("bun", ["run", "test"], { cwd });
    add(samples, name, "test_cpu_s", test.cpuSeconds);
    if (BUILD_REPOS.includes(name)) {
      const build = await runChecked("bun", ["run", "build"], { cwd });
      add(samples, name, "build_cpu_s", build.cpuSeconds);
    }
  }
}

async function measureStack(dirs: SideDirs, samples: Samples): Promise<void> {
  const runDir = join(WORK_ROOT, "run", dirs.side);
  await runChecked("rm", ["-rf", runDir]);
  const m = await runStack(dirs, COMPOSE_FILE, runDir, log);
  for (const service of SERVICES) {
    add(samples, service, "startup_cpu_ms", m.startupCpuMs[service]);
    add(samples, service, "startup_wall_ms", m.startupWallMs[service]);
    add(samples, service, "idle_rss_mib", m.idleRssMiB[service]);
    add(samples, service, "peak_rss_mib", m.peakRssMiB[service]);
    add(samples, service, "load_cpu_s", m.loadCpuS[service]);
    add(samples, service, "image_mb", await imageSizeMB(dirs, service));
  }
  add(samples, "api", "p95_get_checks_ms", m.p95GetChecksMs);
  add(samples, "api", "p95_post_results_ms", m.p95PostResultsMs);
  add(samples, "api", "rps", m.rps);
}

function buildRows(budgets: Budgets, a: Samples, b: Samples): Row[] {
  const rows: Row[] = [];
  for (const [service, metrics] of Object.entries(EMITTED_METRICS)) {
    for (const metric of metrics) {
      const budget = budgets[service]?.[metric];
      const aValues = a[service]?.[metric];
      const bValues = b[service]?.[metric];
      // A missing metric fails the whole run; it is never skipped.
      if (budget === undefined || aValues === undefined || bValues === undefined) {
        throw new Error(`missing metric ${service}.${metric}`);
      }
      const aMedian = median(aValues);
      const bMedian = median(bValues);
      rows.push({
        service,
        metric,
        a: aMedian,
        b: bMedian,
        budget,
        verdict: judge(aMedian, bMedian, budget),
      });
    }
  }
  return rows;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.GITHUB_ACTIONS) {
    log("local run: the numbers are comparable only on this machine");
  }
  const budgets = parseBudgets(await readJson(join(BENCH_DIR, "budgets.json")));
  const missing = missingBudgets(budgets, EMITTED_METRICS);
  if (missing.length > 0) throw new Error(`budgets.json lacks: ${missing.join(", ")}`);
  const baseline = (await readJson(join(BENCH_DIR, "baseline.json"))) as Baseline;
  const refs = await resolveRefs(
    {
      a: args.a,
      b: args.b,
      ...(args.othersRef === undefined ? {} : { othersRef: args.othersRef }),
    },
    baseline,
    lsRemoteTags,
  );
  log(`A: ${JSON.stringify(refs.a)}`);
  log(`B: ${JSON.stringify(refs.b)}`);
  const dirs = {
    a: await prepareSide("a", refs.a),
    b: await prepareSide("b", refs.b),
  };
  const samples: Record<Side, Samples> = { a: {}, b: {} };
  for (let round = 1; round <= args.rounds; round++) {
    for (const side of SIDES) {
      log(`round ${round}/${args.rounds} side ${side}`);
      await measureStack(dirs[side], samples[side]);
      await measureRepoScripts(dirs[side], samples[side]);
    }
  }
  const rows = buildRows(budgets, samples.a, samples.b);
  const table = renderTable(rows);
  console.log(table);
  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, "samples.json"), JSON.stringify({ refs, samples }, null, 2));
  await writeFile(join(args.out, "table.json"), JSON.stringify(rows, null, 2));
  await writeFile(join(args.out, "table.md"), table);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") await appendFile(summary, `${table}\n`);
  const failed = rows.filter((r) => isFailure(r.verdict));
  for (const row of failed) log(`${row.verdict}: ${row.service} ${row.metric}`);
  return failed.length === 0 ? 0 : 1;
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause === undefined ? err.message : `${err.message}: ${describe(err.cause)}`;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`bench: ${describe(err)}`);
  process.exit(2);
}
