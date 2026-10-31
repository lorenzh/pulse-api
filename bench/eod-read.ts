// Usage: bun bench/eod-read.ts --api <worktree> [--seed-with <worktree>] [--today-rows 518400]
//   [--cycles 20] [--checks-limit-ms 392] [--latency-limit-ms 53]
// The end-of-day phase without Docker: seeds a temp 1x database with this change's bench/seed.ts
// (schema of the --seed-with worktree, default --api), adds results of today, runs
// `bun <api>/src/main.ts` as a child process and measures each read right after one ingest
// (bench/eod.ts). Like the full bench it waits until 00:10 UTC and runs again after a UTC day
// change (runEodPhase). Prints one JSON object; exits 1 when `eod_get_checks_ms` or `eod_get_latency_ms`
// is at or above its limit, 2 on an error.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addTodayRows, countTodayRows, processCpuMs, waitReady } from "./cold.ts";
import {
  EOD_CYCLES,
  EOD_TODAY_ROWS,
  type EodPhase,
  type EodTarget,
  overEodLimits,
  runEodPhase,
  runEodReads,
} from "./eod.ts";
import { eodChecksFileJson, tokensFileJson } from "./fixtures.ts";
import { checkIds } from "./load.ts";
import { parseStatusMiB, runChecked } from "./measure.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const OPTIONS = ["api", "seed-with", "today-rows", "cycles", "checks-limit-ms", "latency-limit-ms"];

interface Args {
  api: string;
  seedWith: string;
  todayRows: number;
  cycles: number;
  checksLimitMs: number;
  latencyLimitMs: number;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be > 0`);
  return n;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined || value === "") {
      throw new Error(`bad argument near "${key ?? ""}"`);
    }
    if (!OPTIONS.includes(key.slice(2))) throw new Error(`unknown option ${key}`);
    values.set(key.slice(2), value);
  }
  const api = values.get("api");
  if (api === undefined) throw new Error("--api <worktree> is required");
  const todayRows = Number(values.get("today-rows") ?? EOD_TODAY_ROWS);
  const cycles = Number(values.get("cycles") ?? EOD_CYCLES);
  if (!Number.isInteger(todayRows) || todayRows < 0) throw new Error("--today-rows must be >= 0");
  if (!Number.isInteger(cycles) || cycles < 1) throw new Error("--cycles must be >= 1");
  return {
    api: resolve(api),
    seedWith: resolve(values.get("seed-with") ?? api),
    todayRows,
    cycles,
    checksLimitMs: positive(values.get("checks-limit-ms"), 392, "checks-limit-ms"),
    latencyLimitMs: positive(values.get("latency-limit-ms"), 53, "latency-limit-ms"),
  };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** The api as a child process; its output is dropped. */
function localTarget(api: string, env: Record<string, string>, port: number) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const running = (): number => {
    if (child === undefined) throw new Error("api is not running");
    return child.pid;
  };
  const target: EodTarget = {
    start: () => {
      child = Bun.spawn(["bun", join(api, "src/main.ts")], {
        cwd: api,
        env: { ...process.env, ...env, PORT: String(port) },
        stdout: "ignore",
        stderr: "ignore",
      });
      return waitReady(() => Promise.resolve(`http://127.0.0.1:${port}`));
    },
    cpuMs: () => processCpuMs(running()),
    rssMiB: async () => parseStatusMiB(await Bun.file(`/proc/${running()}/status`).text(), "VmRSS"),
  };
  const stop = async (): Promise<void> => {
    if (child === undefined) return;
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
  };
  return { target, stop };
}

interface EodReadDeps {
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs the phase through `runEodPhase`, so it waits until 00:10 UTC and retries a day change. */
export async function runEodRead(argv: readonly string[], deps: EodReadDeps): Promise<number> {
  const args = parseArgs(argv);
  const { log } = deps;
  const dir = await mkdtemp(join(tmpdir(), "pulse-eod-read-"));
  const db = join(dir, "pulse.db");
  const local = localTarget(
    args.api,
    {
      PULSE_DB: db,
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
    },
    await freePort(),
  );
  let seedNow = 0;
  const phase: EodPhase = {
    seed: async (now) => {
      seedNow = now;
      await rm(db, { force: true });
      await rm(`${db}-wal`, { force: true });
      await rm(`${db}-shm`, { force: true });
      await writeFile(join(dir, "checks.json"), eodChecksFileJson());
      await writeFile(join(dir, "tokens.json"), tokensFileJson());
      const seeded = await runChecked("bun", [
        join(BENCH_DIR, "seed.ts"),
        args.seedWith,
        db,
        "1",
        String(now),
      ]);
      log(seeded.stdout.trim());
      const added = addTodayRows(db, checkIds(), args.todayRows, now);
      log(`added ${added} results of today`);
      return countTodayRows(db, now);
    },
    measure: async () => {
      try {
        return await runEodReads(local.target, log, [], args.cycles);
      } finally {
        await local.stop();
      }
    },
  };
  try {
    const { medians, today_rows, ...metrics } = await runEodPhase(phase, log, deps.now, deps.sleep);
    const failed = overEodLimits(metrics, args.checksLimitMs, args.latencyLimitMs);
    const report = {
      api: args.api,
      seed_with: args.seedWith,
      cycles: args.cycles,
      checks_limit_ms: args.checksLimitMs,
      latency_limit_ms: args.latencyLimitMs,
      seed_now_ms: seedNow,
      today_rows,
      ...metrics,
      medians,
      over_limit: failed,
    };
    console.log(JSON.stringify(report, null, 2));
    return failed.length === 0 ? 0 : 1;
  } finally {
    await local.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(
      await runEodRead(process.argv.slice(2), {
        log: (line) => console.error(`[eod-read] ${line}`),
      }),
    );
  } catch (err) {
    console.error(`eod-read: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
