// Usage: bun bench/seed.ts <api worktree> <output db path> [density] [now ms]
// Seeds a database with the schema of that worktree's own `src/db.ts`, so a schema
// difference between A and B cannot break a run. Shape as the old `src/bench-reads.ts`.
// `density` is the number of results per minute per check (default 1: the 1x seed of the load);
// `now` is the newest timestamp in ms since the epoch (default `Date.now()`).
import { pathToFileURL } from "node:url";
import { seededLine, seedRowsOfMinute } from "./cold.ts";
import { checksFileJson } from "./fixtures.ts";
import { CHECK_INTERVAL_MS, checkIds, SEED_CHECKS, SEED_DAYS } from "./load.ts";

interface Db {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  run(sql: string): unknown;
  close(): void;
}
interface Service {
  upsertChecks(checks: unknown[]): void;
}
interface DbModule {
  openDb(path: string): Db;
}
interface ServiceModule {
  createService(db: Db, options: { now: () => number }): Service;
}

const USAGE = "usage: bun bench/seed.ts <api worktree> <output db path> [density] [now ms]";
const [worktree, output, densityArg, nowArg] = process.argv.slice(2);
const density = Number(densityArg ?? 1);
const now = nowArg === undefined ? Date.now() : Number(nowArg);
if (
  worktree === undefined ||
  output === undefined ||
  !Number.isInteger(density) ||
  density < 1 ||
  !Number.isSafeInteger(now) ||
  now < 0
) {
  console.error(USAGE);
  process.exit(2);
}

// The worktree is a trusted checkout of this project's own repository.
const dbModule = (await import(pathToFileURL(`${worktree}/src/db.ts`).href)) as DbModule;
const serviceModule = (await import(
  pathToFileURL(`${worktree}/src/service.ts`).href
)) as ServiceModule;

const db = dbModule.openDb(output);
const service = serviceModule.createService(db, { now: () => now });
service.upsertChecks(JSON.parse(checksFileJson()).checks);

const insert = db.prepare(
  "INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, attempts) VALUES (?, ?, ?, ?, ?, NULL, 'default', 1)",
);
const minutes = SEED_DAYS * 24 * 60;
db.run("BEGIN");
for (const id of checkIds()) {
  for (let k = 0; k < minutes; k++) {
    for (const row of seedRowsOfMinute(k, density)) {
      const code = row.status === "up" ? 200 : 503;
      insert.run(id, now - row.offsetMs, row.status, code, row.latencyMs);
    }
  }
}
db.run("COMMIT");
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(seededLine(SEED_CHECKS * minutes * density, CHECK_INTERVAL_MS, density, now));
