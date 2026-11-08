// One side in one round: the load, cold-read and end-of-day phases, each with one bind retry.
import { join } from "node:path";
import { type BindRetryDeps, withBindRetry } from "./bind-retry.ts";
import type { Samples } from "./compare.ts";
import { EOD_ROUTES } from "./eod.ts";
import { benchProject, type TeardownCheck } from "./invocation.ts";
import type { PortLease } from "./ports.ts";
import {
  type imageSizeMB,
  type runColdStack,
  type runEodStack,
  type runStack,
  SERVICES,
  type SideDirs,
  type StackIdentity,
  type StackRuntime,
} from "./stack.ts";

const COLD_METRICS = [
  "cold_get_checks_ms",
  "cold_get_uptime_ms",
  "cold_read_cpu_ms",
  "cold_concurrent_ms",
] as const;

export interface SideRoundDeps {
  runStack: typeof runStack;
  runColdStack: typeof runColdStack;
  runEodStack: typeof runEodStack;
  imageSizeMB: typeof imageSizeMB;
  allocate(exclude: readonly number[]): Promise<PortLease>;
  confirmTeardown(project: string): Promise<TeardownCheck>;
  removeDir(path: string): Promise<void>;
  moveFailureLog(from: string, to: string): Promise<void>;
  log(line: string): void;
  /** The invocation id of the run. */
  id: string;
  /** The run's workspace, `.bench/<id>`. */
  workRoot: string;
  composeFile: string;
  /** The `--out` directory. */
  out: string;
}

function add(samples: Samples, service: string, metric: string, value: number): void {
  const metrics = samples[service] ?? {};
  samples[service] = metrics;
  const values = metrics[metric] ?? [];
  metrics[metric] = values;
  values.push(value);
}

function inPhase<T>(
  deps: SideRoundDeps,
  dirs: SideDirs,
  round: number,
  phase: BindRetryDeps<T>["phase"],
  runDir: string,
  attempt: (identity: StackIdentity, failureLogFile: string) => Promise<T>,
): Promise<T> {
  const project = benchProject(deps.id, dirs.side);
  return withBindRetry({
    phase,
    side: dirs.side,
    project,
    failureLogFile: join(deps.out, `failure-round${round}-${dirs.side}.log`),
    attempt1LogFile: join(deps.out, `failure-round${round}-${dirs.side}-${phase}-attempt1.log`),
    allocate: (exclude) => deps.allocate(exclude),
    removeRunDir: () => deps.removeDir(runDir),
    attempt: (lease, failureLogFile) => attempt({ project, ports: lease.ports }, failureLogFile),
    confirmTeardown: () => deps.confirmTeardown(project),
    moveFailureLog: (from, to) => deps.moveFailureLog(from, to),
    log: (line) => deps.log(line),
  });
}

export async function measureStack(
  deps: SideRoundDeps,
  dirs: SideDirs,
  samples: Samples,
  round: number,
  missingOnA: Set<string>,
  runtime: StackRuntime,
): Promise<void> {
  const { composeFile, log } = deps;
  const project = benchProject(deps.id, dirs.side);
  const runDir = join(deps.workRoot, "run", dirs.side);
  const m = await inPhase(deps, dirs, round, "load", runDir, (identity, failureLogFile) =>
    deps.runStack(dirs, identity, composeFile, runDir, log, failureLogFile, runtime),
  );
  for (const service of SERVICES) {
    add(samples, service, "startup_cpu_ms", m.startupCpuMs[service]);
    add(samples, service, "startup_wall_ms", m.startupWallMs[service]);
    add(samples, service, "idle_rss_mib", m.idleRssMiB[service]);
    add(samples, service, "peak_rss_mib", m.peakRssMiB[service]);
    add(samples, service, "load_cpu_s", m.loadCpuS[service]);
    add(samples, service, "image_mb", await deps.imageSizeMB({ project, ports: null }, service));
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
  const coldDir = join(deps.workRoot, "run-cold", dirs.side);
  const cold = await inPhase(deps, dirs, round, "cold", coldDir, (identity, failureLogFile) =>
    deps.runColdStack(dirs, identity, composeFile, coldDir, log, failureLogFile),
  );
  for (const metric of COLD_METRICS) add(samples, "api", metric, cold[metric]);
  const eodDir = join(deps.workRoot, "run-eod", dirs.side);
  const eod = await inPhase(deps, dirs, round, "eod", eodDir, (identity, failureLogFile) =>
    deps.runEodStack(dirs, identity, composeFile, eodDir, log, failureLogFile, () =>
      deps.confirmTeardown(project),
    ),
  );
  for (const { metric } of EOD_ROUTES) {
    // Null only for a route that side A's source lacks (see prepareSide).
    const value = eod[metric];
    if (value === null) missingOnA.add(`api.${metric}`);
    else add(samples, "api", metric, value);
  }
  add(samples, "api", "eod_read_cpu_ms", eod.eod_read_cpu_ms);
}
