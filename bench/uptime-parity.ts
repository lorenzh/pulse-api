// Usage: bun bench/uptime-parity.ts <worktree A> <worktree B> <seed db> <now ms>
// Compares the uptime answers of two api versions on copies of one seed, byte for byte. A is the
// reference (code without `uptime_daily`); B is written at four steps: no stored rows (fill on
// read), half of the checks backfilled, everything backfilled after a restart, and after a late
// result for a stored day. Exit 0 when every B output equals A's output of the same step, 1 when
// one differs, 2 on an error.
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AVAILABILITY_TARGET, checkIds } from "./load.ts";

const DAY_MS = 86_400_000;

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
  getUptime(): unknown[];
  listChecks(): { id: string; slo?: unknown }[];
  ingest(result: Result): boolean;
  missingUptimeDays?(checkId: string): number[];
  fillUptimeDay?(checkId: string, day: number): boolean;
}
interface Component {
  id: string;
  name: string;
  checkIds: string[];
}
interface Api {
  openDb(path: string): Db;
  createService(
    db: Db,
    options: { now: () => number; availabilityTargets: () => ReadonlyMap<string, number> },
  ): Service;
  componentsUptime(components: readonly Component[], uptime: readonly unknown[]): unknown;
}

async function loadApi(worktree: string): Promise<Api> {
  // The worktrees are trusted checkouts of this project's own repository.
  const href = (file: string): string => pathToFileURL(join(worktree, "src", file)).href;
  const db = (await import(href("db.ts"))) as Pick<Api, "openDb">;
  const service = (await import(href("service.ts"))) as Pick<Api, "createService">;
  const components = (await import(href("components.ts"))) as Pick<Api, "componentsUptime">;
  return {
    openDb: db.openDb,
    createService: service.createService,
    componentsUptime: components.componentsUptime,
  };
}

const ids = checkIds();
const COMPONENTS: Component[] = [
  { id: "first", name: "First", checkIds: ids.slice(0, 10) },
  { id: "second", name: "Second", checkIds: ids.slice(10) },
];

function output(api: Api, service: Service): string {
  const uptime = service.getUptime();
  return JSON.stringify({
    uptime,
    components: api.componentsUptime(COMPONENTS, uptime),
    checks: service.listChecks().map((c) => ({ id: c.id, slo: c.slo })),
  });
}

function fillDays(service: Service, checks: readonly string[]): number {
  if (service.missingUptimeDays === undefined || service.fillUptimeDay === undefined) {
    throw new Error("worktree B has no uptime backfill (missingUptimeDays, fillUptimeDay)");
  }
  let filled = 0;
  for (const id of checks) {
    for (const day of service.missingUptimeDays(id)) {
      if (service.fillUptimeDay(id, day)) filled++;
    }
  }
  return filled;
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
    console.error("usage: bun bench/uptime-parity.ts <worktree A> <worktree B> <seed db> <now ms>");
    return 2;
  }
  const out = await mkdtemp(join(tmpdir(), "pulse-uptime-parity-"));
  const options = {
    now: () => now,
    availabilityTargets: () => new Map(ids.map((id) => [id, AVAILABILITY_TARGET] as const)),
  };
  const late: Result = {
    checkId: "c0",
    status: "down",
    location: "default",
    timestamp: now - 2 * DAY_MS + 30_000,
    statusCode: 503,
    latencyMs: 0,
    reason: "parity late result",
    attempts: 1,
  };
  const copy = async (name: string): Promise<string> => {
    const path = join(out, name);
    await copyFile(resolve(seed), path);
    return path;
  };
  const written = new Map<string, string>();
  const write = async (name: string, text: string): Promise<void> => {
    written.set(name, text);
    await writeFile(join(out, `${name}.json`), text);
  };

  const a = await loadApi(resolve(aDir));
  const aDb = a.openDb(await copy("a.db"));
  const aService = a.createService(aDb, options);
  const aBefore = output(a, aService);
  await write("a-1-no-rows", aBefore);
  await write("a-2-partial", aBefore);
  await write("a-3-restart", aBefore);
  aService.ingest(late);
  await write("a-4-late", output(a, aService));
  aDb.close();

  const b = await loadApi(resolve(bDir));
  const noRows = b.openDb(await copy("b-1.db"));
  await write("b-1-no-rows", output(b, b.createService(noRows, options)));
  noRows.close();
  const bPath = await copy("b-2.db");
  const partialDb = b.openDb(bPath);
  const partial = b.createService(partialDb, options);
  const half = fillDays(partial, ids.slice(0, ids.length / 2));
  await write("b-2-partial", output(b, partial));
  const rest = fillDays(partial, ids);
  partialDb.close();
  const restartDb = b.openDb(bPath);
  const restarted = b.createService(restartDb, options);
  await write("b-3-restart", output(b, restarted));
  restarted.ingest(late);
  await write("b-4-late", output(b, restarted));
  restartDb.close();

  console.log(`outputs in ${out} (B backfill: ${half} days for half the checks, then ${rest})`);
  let isEqual = true;
  for (const step of ["1-no-rows", "2-partial", "3-restart", "4-late"]) {
    const aText = written.get(`a-${step}`) ?? "";
    const bText = written.get(`b-${step}`) ?? "";
    const hash = (text: string): string =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const verdict = aText === bText ? "equal" : "DIFFERENT";
    if (aText !== bText) isEqual = false;
    console.log(`${step}: A ${hash(aText)} B ${hash(bText)} ${verdict} (${aText.length} bytes)`);
  }
  return isEqual ? 0 : 1;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`uptime-parity: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
