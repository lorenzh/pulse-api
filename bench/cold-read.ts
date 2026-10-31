// Usage: bun bench/cold-read.ts --api <worktree> [--seed-with <worktree>] [--density 10] [--limit-ms 400]
// Cold reads without Docker: seeds a temp database with this change's bench/seed.ts (schema of the
// --seed-with worktree, default --api), runs `bun <api>/src/main.ts` as a child process, and runs
// steps 1-3 of the cold-read phase (bench/cold.ts). Prints one JSON object; exits 1 when a cold
// wall time is at or above the limit, 2 on an error.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ColdTarget,
  countTodayRows,
  overLimit,
  processCpuMs,
  runColdReads,
  waitReady,
} from "./cold.ts";
import { checksFileJson, tokensFileJson } from "./fixtures.ts";
import { runChecked } from "./measure.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const OPTIONS = ["api", "seed-with", "density", "limit-ms"];
/** The start delay of the latency and uptime rollup runners of the api. */
const ROLLUP_DELAY_MS = 5000;

interface Args {
  api: string;
  seedWith: string;
  density: number;
  limitMs: number;
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
  const density = Number(values.get("density") ?? 10);
  const limitMs = Number(values.get("limit-ms") ?? 400);
  if (!Number.isInteger(density) || density < 1) throw new Error("--density must be >= 1");
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new Error("--limit-ms must be > 0");
  return { api: resolve(api), seedWith: resolve(values.get("seed-with") ?? api), density, limitMs };
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

interface StartRecord {
  kind: "first" | "restart";
  ready_wall_ms: number;
  ready_cpu_ms: number;
}

/** Collect the lines of a child's output stream. */
async function collectLines(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
  }
  if (rest !== "") lines.push(rest);
}

function localTarget(api: string, env: Record<string, string>, port: number) {
  const base = `http://127.0.0.1:${port}`;
  const lines: string[] = [];
  const starts: StartRecord[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawn = async (kind: StartRecord["kind"]): Promise<string> => {
    const started = performance.now();
    const proc = Bun.spawn(["bun", join(api, "src/main.ts")], {
      cwd: api,
      env: { ...process.env, ...env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = proc;
    void collectLines(proc.stdout, lines);
    void collectLines(proc.stderr, lines);
    const url = await waitReady(() => Promise.resolve(base));
    readyAt = performance.now();
    const readyWall = Math.round(readyAt - started);
    starts.push({ kind, ready_wall_ms: readyWall, ready_cpu_ms: await processCpuMs(proc.pid) });
    return url;
  };
  let readyAt = 0;
  /**
   * The rollup runners start 5 s after listen. Before the first restart, wait for their first
   * runs to end, so the log holds the backfill lines of the first start.
   */
  const waitForBackfills = async (): Promise<void> => {
    const count = (text: string): number => lines.filter((l) => l.includes(text)).length;
    const deadline = performance.now() + 300_000;
    while (performance.now() < deadline) {
      const isDelayOver = performance.now() - readyAt > ROLLUP_DELAY_MS + 1000;
      const ended = count("rollup: backfill done") + count("rollup failed");
      if (isDelayOver && ended >= count("rollup: backfill started")) return;
      await Bun.sleep(100);
    }
  };
  const stop = async (): Promise<void> => {
    if (child === undefined) return;
    if (starts.length === 1) await waitForBackfills();
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
  };
  const target: ColdTarget = {
    start: () => spawn("first"),
    restart: async () => {
      await stop();
      return spawn("restart");
    },
    cpuMs: () => {
      if (child === undefined) throw new Error("api is not running");
      return processCpuMs(child.pid);
    },
  };
  return { target, stop, lines, starts };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dir = await mkdtemp(join(tmpdir(), "pulse-cold-read-"));
  const log = (line: string): void => console.error(`[cold-read] ${line}`);
  try {
    const db = join(dir, "pulse.db");
    await writeFile(join(dir, "checks.json"), checksFileJson());
    await writeFile(join(dir, "tokens.json"), tokensFileJson());
    const seedNow = Date.now();
    const seedStarted = performance.now();
    const seeded = await runChecked("bun", [
      join(BENCH_DIR, "seed.ts"),
      args.seedWith,
      db,
      String(args.density),
      String(seedNow),
    ]);
    log(`${seeded.stdout.trim()} in ${Math.round(performance.now() - seedStarted)} ms`);
    const todayRows = countTodayRows(db, seedNow);
    const local = localTarget(
      args.api,
      {
        PULSE_DB: db,
        PULSE_CHECKS_FILE: join(dir, "checks.json"),
        PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      },
      await freePort(),
    );
    try {
      const result = await runColdReads(local.target, log);
      const failed = overLimit(result, args.limitMs);
      const report = {
        api: args.api,
        seed_with: args.seedWith,
        density: args.density,
        limit_ms: args.limitMs,
        seed_now_ms: seedNow,
        today_rows: todayRows,
        ...result,
        starts: local.starts,
        rollup_log: local.lines.filter((l) => l.includes("rollup")),
        over_limit: failed,
      };
      console.log(JSON.stringify(report, null, 2));
      return failed.length === 0 ? 0 : 1;
    } finally {
      await local.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`cold-read: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
