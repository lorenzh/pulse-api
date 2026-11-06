// Entry point: bun bench/run.ts --a <ref> --b <ref> [--rounds n] [--others-ref <ref>]
//   [--b-ref <repo>=<ref>]... [--simulate-services | --service-tokens]
//   [--expect-report status|notify]... [--out <dir>]
// Interleaved A/B comparison of CPU time and memory per service. See bench/README.md.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLD_DENSITY } from "./cold.ts";
import {
  buildRows,
  EMITTED_METRICS,
  isFailure,
  missingBudgets,
  parseBudgets,
  renderTable,
  type Samples,
} from "./compare.ts";
import { EOD_ROUTES } from "./eod.ts";
import { OPTIONAL_ROUTES, routesMissingAt } from "./load.ts";
import { runChecked } from "./measure.ts";
import {
  type Baseline,
  checkoutMismatch,
  containsCommit,
  parseBRefs,
  REPOS,
  type RepoName,
  refLines,
  repoUrl,
  resolveRefs,
  resolveShas,
  sameShaMismatch,
  UsageError,
} from "./refs.ts";
import { RUNTIME_SERVICES, type RuntimeService, runtimeMode } from "./runtime-fixture.ts";
import {
  buildImages,
  imageSizeMB,
  runColdStack,
  runEodStack,
  runStack,
  SERVICES,
  type SideDirs,
  type StackRuntime,
} from "./stack.ts";

const COLD_METRICS = [
  "cold_get_checks_ms",
  "cold_get_uptime_ms",
  "cold_read_cpu_ms",
  "cold_concurrent_ms",
] as const;

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH_DIR, "..");
const WORK_ROOT = join(ROOT, ".bench");
const COMPOSE_FILE = join(BENCH_DIR, "compose.bench.yaml");
const BUILD_REPOS: readonly RepoName[] = ["contract", "kit"];

type Side = "a" | "b";
const SIDES: readonly Side[] = ["a", "b"];

interface Args {
  a: string;
  b: string;
  rounds: number;
  othersRef?: string;
  bRefs: Partial<Record<RepoName, string>>;
  runtime: StackRuntime;
  out: string;
}

const VALUE_OPTIONS = ["a", "b", "rounds", "others-ref", "out", "b-ref", "expect-report"];
const FLAG_OPTIONS = ["simulate-services", "service-tokens"];
const REPEATABLE = ["b-ref", "expect-report"];

function readOptions(argv: readonly string[]): {
  values: Map<string, string[]>;
  flags: Set<string>;
} {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.startsWith("--") ? argv[i]?.slice(2) : undefined;
    if (key !== undefined && FLAG_OPTIONS.includes(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (key === undefined || !VALUE_OPTIONS.includes(key)) {
      throw new UsageError(`unknown option ${argv[i] ?? ""}`);
    }
    if (value === undefined || value === "") throw new UsageError(`--${key} needs a value`);
    const list = values.get(key) ?? [];
    if (list.length > 0 && !REPEATABLE.includes(key)) throw new UsageError(`--${key} given twice`);
    values.set(key, [...list, value]);
    i++;
  }
  return { values, flags };
}

function expectedReports(values: readonly string[]): RuntimeService[] {
  return values.map((value) => {
    const service = RUNTIME_SERVICES.find((s) => s === value);
    if (service === undefined) throw new UsageError("--expect-report takes status or notify");
    return service;
  });
}

function parseArgs(argv: readonly string[]): Args {
  const { values, flags } = readOptions(argv);
  const one = (key: string): string | undefined => values.get(key)?.[0];
  const rounds = Number(one("rounds") ?? 5);
  if (!Number.isInteger(rounds) || rounds < 1)
    throw new UsageError("--rounds must be an integer >= 1");
  const othersRef = one("others-ref");
  return {
    a: one("a") ?? "baseline",
    b: one("b") ?? "main",
    rounds,
    ...(othersRef === undefined ? {} : { othersRef }),
    bRefs: parseBRefs(values.get("b-ref") ?? [], othersRef),
    runtime: {
      mode: runtimeMode(flags.has("simulate-services"), flags.has("service-tokens")),
      expectReports: expectedReports(values.get("expect-report") ?? []),
    },
    out: resolve(one("out") ?? join(ROOT, "bench-out")),
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

async function ensureClone(name: RepoName): Promise<string> {
  const clone = join(WORK_ROOT, "repos", name);
  if (!(await Bun.file(join(clone, ".git", "HEAD")).exists())) {
    await mkdir(dirname(clone), { recursive: true });
    await runChecked("git", ["clone", "--filter=blob:none", "--no-checkout", repoUrl(name), clone]);
  }
  return clone;
}

/** Fetches `ref` once and returns its full commit SHA; later rounds never resolve it again. */
async function resolveSha(name: RepoName, ref: string): Promise<string> {
  const clone = await ensureClone(name);
  await runChecked("git", ["fetch", "origin", ref], { cwd: clone });
  const { stdout } = await runChecked("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: clone });
  return stdout.trim();
}

/** Adds a worktree of the resolved `sha`, verifies its HEAD and installs its dependencies. */
async function checkout(name: RepoName, side: Side, sha: string): Promise<string> {
  const clone = await ensureClone(name);
  const dir = join(WORK_ROOT, "work", side, name);
  await runChecked("rm", ["-rf", dir]);
  await runChecked("git", ["worktree", "prune"], { cwd: clone });
  await runChecked("git", ["worktree", "add", "--detach", dir, sha], { cwd: clone });
  const head = await runChecked("git", ["rev-parse", "HEAD"], { cwd: dir });
  const mismatch = checkoutMismatch(name, side, sha, head.stdout);
  if (mismatch !== undefined) throw new Error(mismatch);
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
  const coldSeedDb = join(dirname(seedDb), "pulse-10x.db");
  const seeded = await runChecked("bun", [
    join(BENCH_DIR, "seed.ts"),
    apiDir,
    coldSeedDb,
    String(COLD_DENSITY),
  ]);
  log(`cold-read seed (${side}): ${seeded.stdout.trim()}`);
  // Only A may predate a measured route; B must serve them all, so a 404 there fails the load.
  const missingRoutes =
    side === "a" ? await routesMissingAt(OPTIONAL_ROUTES, (c) => containsCommit(apiDir, c)) : [];
  if (missingRoutes.length > 0) log(`api A lacks ${missingRoutes.join(", ")}: not measured on A`);
  const dirs: SideDirs = { side, work, seedDb, coldSeedDb, missingRoutes };
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

async function measureStack(
  dirs: SideDirs,
  samples: Samples,
  failureLogFile: string,
  missingOnA: Set<string>,
  runtime: StackRuntime,
): Promise<void> {
  const runDir = join(WORK_ROOT, "run", dirs.side);
  await runChecked("rm", ["-rf", runDir]);
  const m = await runStack(dirs, COMPOSE_FILE, runDir, log, failureLogFile, runtime);
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
  for (const [metric, value] of [
    ["p95_get_latency_ms", m.p95GetLatencyMs],
    ["p95_get_check_latency_ms", m.p95GetCheckLatencyMs],
  ] as const) {
    // Null only for a route that side A's source lacks (see prepareSide).
    if (value === null) missingOnA.add(`api.${metric}`);
    else add(samples, "api", metric, value);
  }
  add(samples, "api", "rps", m.rps);
  const coldDir = join(WORK_ROOT, "run-cold", dirs.side);
  await runChecked("rm", ["-rf", coldDir]);
  const cold = await runColdStack(dirs, COMPOSE_FILE, coldDir, log, failureLogFile);
  for (const metric of COLD_METRICS) add(samples, "api", metric, cold[metric]);
  const eodDir = join(WORK_ROOT, "run-eod", dirs.side);
  await runChecked("rm", ["-rf", eodDir]);
  const eod = await runEodStack(dirs, COMPOSE_FILE, eodDir, log, failureLogFile);
  for (const { metric } of EOD_ROUTES) {
    // Null only for a route that side A's source lacks (see prepareSide).
    const value = eod[metric];
    if (value === null) missingOnA.add(`api.${metric}`);
    else add(samples, "api", metric, value);
  }
  add(samples, "api", "eod_read_cpu_ms", eod.eod_read_cpu_ms);
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
  const names = await resolveRefs(
    {
      a: args.a,
      b: args.b,
      ...(args.othersRef === undefined ? {} : { othersRef: args.othersRef }),
      bRefs: args.bRefs,
    },
    baseline,
    lsRemoteTags,
  );
  log(`A: ${JSON.stringify(names.a)}`);
  log(`B: ${JSON.stringify(names.b)}`);
  // Resolved once, before round 1: a ref that moves later cannot change what a side runs.
  const refs = await resolveShas(names, resolveSha);
  for (const line of refLines(refs)) log(line);
  if (args.othersRef !== undefined) {
    const mismatch = sameShaMismatch(refs, args.bRefs);
    if (mismatch !== undefined) throw new Error(mismatch);
  }
  const dirs = {
    a: await prepareSide("a", refs.a),
    b: await prepareSide("b", refs.b),
  };
  const samples: Record<Side, Samples> = { a: {}, b: {} };
  const missingOnA = new Set<string>();
  for (let round = 1; round <= args.rounds; round++) {
    for (const side of SIDES) {
      log(`round ${round}/${args.rounds} side ${side}`);
      const failureLog = join(args.out, `failure-round${round}-${side}.log`);
      await measureStack(dirs[side], samples[side], failureLog, missingOnA, args.runtime);
      await measureRepoScripts(dirs[side], samples[side]);
    }
  }
  const rows = buildRows(budgets, samples.a, samples.b, missingOnA);
  const table = renderTable(rows);
  console.log(table);
  await mkdir(args.out, { recursive: true });
  await writeFile(
    join(args.out, "samples.json"),
    JSON.stringify({ refs: names, shas: refs, samples }, null, 2),
  );
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
