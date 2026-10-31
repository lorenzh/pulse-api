// Usage: bun bench/today-parity.ts <worktree A> <worktree B> <seed db> <now ms>
// Compares every answer that depends on today's results of two api versions, byte for byte, on
// copies of one 1x seed that each get a full day of results of today (`EOD_TODAY_ROWS`). Both
// sides see the same clock and inputs at five steps: the first read, a fixed ingest sequence, a
// restart, the clock 40 s later, and a UTC day rollover. Exit 0 when every B output equals A's
// output of the same step, 1 when one differs, 2 on an error.
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { addTodayRows } from "./cold.ts";
import { EOD_EARLIEST_MS, EOD_TODAY_ROWS } from "./eod.ts";
import { eodComponents } from "./fixtures.ts";
import { AVAILABILITY_TARGET, checkIds } from "./load.ts";

const DAY_MS = 86_400_000;
const STEPS = ["1-build", "2-ingest", "3-restart", "4-later", "5-rollover"] as const;

interface Db {
  close(): void;
}
interface Result {
  checkId: string;
  timestamp: number;
  status: string;
  statusCode: number | null;
  latencyMs: number;
  reason: string | null;
  location: string;
  attempts: number;
}
interface Service {
  listChecks(): unknown[];
  getUptime(): unknown[];
  getLatency(): unknown[];
  getCheckLatency(id: string): unknown;
  getSloDays(id: string): unknown[];
  listCheckStates(): unknown[];
  listIncidents(status: "open"): unknown[];
  listLatencyCheckIds(): string[];
  ingest(result: Result, isGenerated?: boolean): boolean;
}
type Component = ReturnType<typeof eodComponents>[number];
interface Api {
  openDb(path: string): Db;
  createService(
    db: Db,
    options: { now: () => number; availabilityTargets: () => ReadonlyMap<string, number> },
  ): Service;
  componentsUptime(components: readonly Component[], uptime: readonly unknown[]): unknown;
  componentsWithState(
    components: readonly Component[],
    states: readonly unknown[],
    uptime: readonly unknown[],
    openIncidents: readonly unknown[],
    sloDays: (id: string) => readonly unknown[],
  ): unknown;
  componentBudgets(
    components: readonly Component[],
    sloDays: (id: string) => readonly unknown[],
  ): unknown;
}

async function loadApi(worktree: string): Promise<Api> {
  // The worktrees are trusted checkouts of this project's own repository.
  const href = (file: string): string => pathToFileURL(join(worktree, "src", file)).href;
  const db = (await import(href("db.ts"))) as Pick<Api, "openDb">;
  const service = (await import(href("service.ts"))) as Pick<Api, "createService">;
  const components = (await import(href("components.ts"))) as Pick<
    Api,
    "componentsUptime" | "componentsWithState" | "componentBudgets"
  >;
  return {
    openDb: db.openDb,
    createService: service.createService,
    componentsUptime: components.componentsUptime,
    componentsWithState: components.componentsWithState,
    componentBudgets: components.componentBudgets,
  };
}

const COMPONENTS = eodComponents();

function output(api: Api, s: Service): string {
  const uptime = s.getUptime();
  const sloDays = (id: string): unknown[] => s.getSloDays(id);
  return JSON.stringify({
    checks: s.listChecks(),
    uptime,
    latency: s.getLatency(),
    checkLatency: s.listLatencyCheckIds().map((id) => s.getCheckLatency(id)),
    componentsUptime: api.componentsUptime(COMPONENTS, uptime),
    components: api.componentsWithState(
      COMPONENTS,
      s.listCheckStates(),
      uptime,
      s.listIncidents("open"),
      sloDays,
    ),
    budgets: api.componentBudgets(COMPONENTS, sloDays),
  });
}

function result(timestamp: number, status: "up" | "degraded" | "down", latencyMs: number): Result {
  return {
    checkId: checkIds()[0] ?? "",
    timestamp,
    status,
    statusCode: status === "down" ? 503 : 200,
    latencyMs,
    reason: status === "up" ? null : `parity ${status}`,
    location: "parity",
    attempts: 1,
  };
}

/** Run the five steps on one side; returns the output per step. */
async function runSide(api: Api, dbPath: string, start: number): Promise<string[]> {
  const clock = { t: start };
  const options = {
    now: () => clock.t,
    availabilityTargets: () => new Map(checkIds().map((id) => [id, AVAILABILITY_TARGET] as const)),
  };
  const outputs: string[] = [];
  let db = api.openDb(dbPath);
  let s = api.createService(db, options);
  outputs.push(output(api, s));
  s.ingest(result(start - 5000, "up", 11));
  s.ingest(result(start - 4000, "degraded", 22));
  s.ingest(result(start - 3000, "down", 9999));
  // Late: the location holds start - 3000 already.
  s.ingest(result(start - 6000, "up", 33));
  // A repeat, stored once.
  s.ingest(result(start - 5000, "up", 11));
  // A generated sample on an occupied timestamp moves by 1 ms.
  s.ingest(result(start - 3000, "up", 44), true);
  s.ingest(result(start + 30_000, "up", 55));
  outputs.push(output(api, s));
  db.close();
  db = api.openDb(dbPath);
  s = api.createService(db, options);
  outputs.push(output(api, s));
  clock.t = start + 40_000;
  outputs.push(output(api, s));
  const midnight = (Math.floor(start / DAY_MS) + 1) * DAY_MS;
  s.ingest(result(midnight + 10_000, "up", 66));
  clock.t = midnight + 60_000;
  outputs.push(output(api, s));
  db.close();
  return outputs;
}

async function main(): Promise<number> {
  const [aDir, bDir, seed, nowArg] = process.argv.slice(2);
  const now = Number(nowArg);
  if (
    aDir === undefined ||
    bDir === undefined ||
    seed === undefined ||
    !Number.isSafeInteger(now)
  ) {
    console.error("usage: bun bench/today-parity.ts <worktree A> <worktree B> <seed db> <now ms>");
    return 2;
  }
  if (now % DAY_MS < EOD_EARLIEST_MS) {
    console.error("today-parity: <now ms> must be at least 10 min after a UTC midnight");
    return 2;
  }
  const out = await mkdtemp(join(tmpdir(), "pulse-today-parity-"));
  const outputs = new Map<string, string[]>();
  for (const [side, dir] of [
    ["a", aDir],
    ["b", bDir],
  ] as const) {
    const dbPath = join(out, `${side}.db`);
    await copyFile(resolve(seed), dbPath);
    const added = addTodayRows(dbPath, checkIds(), EOD_TODAY_ROWS, now);
    console.log(`${side}: added ${added} results of today`);
    const texts = await runSide(await loadApi(resolve(dir)), dbPath, now);
    outputs.set(side, texts);
    for (const [i, step] of STEPS.entries()) {
      await writeFile(join(out, `${side}-${step}.json`), texts[i] ?? "");
    }
  }
  console.log(`outputs in ${out}`);
  const hash = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  let isEqual = true;
  for (const [i, step] of STEPS.entries()) {
    const aText = outputs.get("a")?.[i] ?? "";
    const bText = outputs.get("b")?.[i] ?? "";
    if (aText !== bText) isEqual = false;
    const verdict = aText === bText ? "equal" : "DIFFERENT";
    console.log(`${step}: A ${hash(aText)} B ${hash(bText)} ${verdict} (${aText.length} bytes)`);
  }
  return isEqual ? 0 : 1;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`today-parity: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
