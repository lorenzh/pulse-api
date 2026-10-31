// One run: a compose stack of the four services plus the bench target, driven by the fixed load.
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ColdResult, composeTarget, countTodayRows, runColdReads } from "./cold.ts";
import { checksFileJson, tokensFileJson } from "./fixtures.ts";
import { IDLE_S, type OptionalRoute, runLoad } from "./load.ts";
import { readContainerProcess, runChecked, runCommand } from "./measure.ts";

export const SERVICES = ["api", "probe", "status", "notify"] as const;
export type ServiceName = (typeof SERVICES)[number];

const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 50;
// Container ports of /readyz per service (the harness reads the published host port).
const CONTAINER_PORT: Record<ServiceName, number> = {
  api: 3000,
  probe: 9100,
  status: 8080,
  notify: 9100,
};

export interface SideDirs {
  side: "a" | "b";
  /** Worktree directory per repository name. */
  work: Record<string, string>;
  /** Seeded database of this side's api. */
  seedDb: string;
  /** The 10x seed of the cold-read phase, made by this side's api. */
  coldSeedDb: string;
  /** Measured routes this side's api lacks; always empty for side B. */
  missingRoutes: OptionalRoute[];
}

export interface StackMetrics {
  startupCpuMs: Record<ServiceName, number>;
  startupWallMs: Record<ServiceName, number>;
  idleRssMiB: Record<ServiceName, number>;
  peakRssMiB: Record<ServiceName, number>;
  loadCpuS: Record<ServiceName, number>;
  p95GetChecksMs: number;
  p95PostResultsMs: number;
  p95GetLatencyMs: number | null;
  p95GetCheckLatencyMs: number | null;
  rps: number;
}

function composeArgs(project: string, composeFile: string): string[] {
  return ["compose", "-f", composeFile, "-p", project];
}

function stackEnv(dirs: SideDirs, project: string, runDir: string): Record<string, string> {
  return {
    BENCH_PROJECT: project,
    BENCH_SIDE: dirs.side,
    BENCH_RUN_DIR: runDir,
    BENCH_API_DIR: dirs.work.api ?? "",
    BENCH_PROBE_DIR: dirs.work.probe ?? "",
    BENCH_STATUS_DIR: dirs.work.status ?? "",
    BENCH_NOTIFY_DIR: dirs.work.notify ?? "",
  };
}

/** Build the images of one side once; later runs reuse them. */
export async function buildImages(
  dirs: SideDirs,
  composeFile: string,
  runDir: string,
): Promise<void> {
  const project = `pulse-bench-${dirs.side}`;
  await runChecked("docker", [...composeArgs(project, composeFile), "build"], {
    env: stackEnv(dirs, project, runDir),
  });
}

export async function imageSizeMB(dirs: SideDirs, service: ServiceName): Promise<number> {
  const { stdout } = await runChecked("docker", [
    "image",
    "inspect",
    `pulse-bench-${dirs.side}-${service}`,
    "--format",
    "{{.Size}}",
  ]);
  return Number(stdout.trim()) / 1e6;
}

async function prepareRunDir(runDir: string, seedDb: string): Promise<void> {
  for (const dir of ["config", "api-data", "notify-data"]) {
    await mkdir(join(runDir, dir), { recursive: true });
  }
  await writeFile(join(runDir, "config", "checks.json"), checksFileJson());
  await writeFile(join(runDir, "config", "tokens.json"), tokensFileJson());
  await copyFile(seedDb, join(runDir, "api-data", "pulse.db"));
  // The services run as the unprivileged `bun` user of their images.
  for (const path of [runDir, join(runDir, "api-data"), join(runDir, "notify-data")]) {
    await chmod(path, 0o777);
  }
  await chmod(join(runDir, "api-data", "pulse.db"), 0o666);
}

async function hostPort(compose: string[], service: ServiceName): Promise<number> {
  const { stdout } = await runChecked("docker", [
    ...compose,
    "port",
    service,
    String(CONTAINER_PORT[service]),
  ]);
  const port = Number(stdout.trim().split(":").pop());
  if (!Number.isInteger(port)) throw new Error(`no published port for ${service}`);
  return port;
}

async function isReady(port: number): Promise<boolean> {
  try {
    // `connection: close` keeps a pooled socket from outliving the server's keep-alive
    // timeout: the load would reuse it and fail with a reset.
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      headers: { connection: "close" },
    });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    // Not listening yet: the poll tries again until the timeout.
    return false;
  }
}

/** Poll /readyz every 50 ms; returns the wall time from `startedAt`. */
async function waitReady(service: ServiceName, port: number, startedAt: number): Promise<number> {
  while (performance.now() - startedAt < READY_TIMEOUT_MS) {
    if (await isReady(port)) return performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${service} was not ready within ${READY_TIMEOUT_MS / 1000} s`);
}

const containerName = (project: string, service: ServiceName): string => `${project}-${service}`;

/** Start the given services, wait for /readyz and read the CPU time at the first 200. */
async function startServices(
  compose: string[],
  project: string,
  env: Record<string, string>,
  services: readonly ServiceName[],
): Promise<Record<string, { wallMs: number; cpuMs: number; port: number }>> {
  const startedAt = performance.now();
  await runChecked("docker", [...compose, "up", "-d", "--no-build", ...services], { env });
  const entries = await Promise.all(
    services.map(async (service) => {
      const port = await hostPort(compose, service);
      const wallMs = await waitReady(service, port, startedAt);
      const sample = await readContainerProcess(containerName(project, service));
      return [service, { wallMs, cpuMs: sample.cpuSeconds * 1000, port }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function perService<T>(fn: (service: ServiceName) => T): Record<ServiceName, T> {
  return {
    api: fn("api"),
    probe: fn("probe"),
    status: fn("status"),
    notify: fn("notify"),
  };
}

export async function runStack(
  dirs: SideDirs,
  composeFile: string,
  runDir: string,
  log: (line: string) => void,
  failureLogFile: string,
): Promise<StackMetrics> {
  const project = `pulse-bench-${dirs.side}`;
  const compose = composeArgs(project, composeFile);
  const env = stackEnv(dirs, project, runDir);
  await prepareRunDir(runDir, dirs.seedDb);
  try {
    const first = await startServices(compose, project, env, ["api"]);
    const rest = await startServices(compose, project, env, ["probe", "status", "notify"]);
    const started = { ...first, ...rest };
    const info = (service: ServiceName): { wallMs: number; cpuMs: number; port: number } => {
      const value = started[service];
      if (value === undefined) throw new Error(`${service} did not start`);
      return value;
    };
    log(`stack ${project} ready`);

    await new Promise((resolve) => setTimeout(resolve, IDLE_S * 1000));
    const idle = await sampleAll(project);

    const atWindowStart: Partial<Record<ServiceName, number>> = {};
    const load = await runLoad({
      apiUrl: `http://127.0.0.1:${info("api").port}`,
      missingRoutes: dirs.missingRoutes,
      onWindowStart: async () => {
        const samples = await sampleAll(project);
        for (const service of SERVICES) atWindowStart[service] = samples[service].cpuSeconds;
      },
    });
    if (load.retriedGets + load.droppedPosts > 0) {
      log(
        `connections closed before a response: ${load.retriedGets} GETs retried, ${load.droppedPosts} POSTs dropped`,
      );
    }
    const end = await sampleAll(project);
    return {
      startupCpuMs: perService((s) => info(s).cpuMs),
      startupWallMs: perService((s) => info(s).wallMs),
      idleRssMiB: perService((s) => idle[s].rssMiB),
      peakRssMiB: perService((s) => end[s].peakRssMiB),
      loadCpuS: perService((s) => end[s].cpuSeconds - (atWindowStart[s] ?? 0)),
      p95GetChecksMs: load.p95GetChecksMs,
      p95PostResultsMs: load.p95PostResultsMs,
      p95GetLatencyMs: load.p95GetLatencyMs,
      p95GetCheckLatencyMs: load.p95GetCheckLatencyMs,
      rps: load.rps,
    };
  } catch (err) {
    await dumpStack(compose, env, failureLogFile, log);
    throw err;
  } finally {
    // A failing teardown must not hide the run's own error: report it and go on.
    const down = await runCommand(
      "docker",
      [...compose, "down", "-v", "--remove-orphans", "-t", "5"],
      {
        env,
      },
    );
    if (down.code !== 0) log(`compose down failed: ${down.stderr.slice(-200)}`);
  }
}

/**
 * The cold-read phase: only the api, on a fresh copy of the side's 10x seed. Runs after the 1x
 * stack run, which has torn its project down.
 */
export async function runColdStack(
  dirs: SideDirs,
  composeFile: string,
  runDir: string,
  log: (line: string) => void,
  failureLogFile: string,
): Promise<ColdResult> {
  const project = `pulse-bench-${dirs.side}`;
  const compose = composeArgs(project, composeFile);
  const env = stackEnv(dirs, project, runDir);
  await prepareRunDir(runDir, dirs.coldSeedDb);
  log(`cold: seed has ${countTodayRows(dirs.coldSeedDb, Date.now())} rows of today (UTC)`);
  try {
    const target = composeTarget({ compose, env, container: containerName(project, "api") });
    return await runColdReads(target, log);
  } catch (err) {
    await dumpStack(compose, env, failureLogFile, log);
    throw err;
  } finally {
    const down = await runCommand(
      "docker",
      [...compose, "down", "-v", "--remove-orphans", "-t", "5"],
      { env },
    );
    if (down.code !== 0) log(`compose down failed: ${down.stderr.slice(-200)}`);
  }
}

/** Save container states and logs of a failed run before the teardown removes them. */
async function dumpStack(
  compose: string[],
  env: Record<string, string>,
  file: string,
  log: (line: string) => void,
): Promise<void> {
  const ps = await runCommand("docker", [...compose, "ps", "-a"], { env });
  const logs = await runCommand("docker", [...compose, "logs", "--timestamps", "--no-color"], {
    env,
  });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${ps.stdout}${ps.stderr}\n${logs.stdout}${logs.stderr}`);
  log(`stack state and logs: ${file}`);
}

async function sampleAll(
  project: string,
): Promise<Record<ServiceName, Awaited<ReturnType<typeof readContainerProcess>>>> {
  const [api, probe, status, notify] = await Promise.all(
    SERVICES.map((s) => readContainerProcess(containerName(project, s))),
  );
  if (api === undefined || probe === undefined || status === undefined || notify === undefined) {
    throw new Error("missing process sample");
  }
  return { api, probe, status, notify };
}
