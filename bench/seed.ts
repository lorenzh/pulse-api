// Usage: bun bench/seed.ts <api worktree> <output db path>
// Seeds a database with the schema of that worktree's own `src/db.ts`, so a schema
// difference between A and B cannot break a run. Shape as the old `src/bench-reads.ts`.
import { pathToFileURL } from "node:url";
import { checksFileJson } from "./fixtures.ts";
import { CHECK_INTERVAL_MS, checkIds, SEED_CHECKS, SEED_DAYS } from "./load.ts";

const MINUTE = 60_000;

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

const [worktree, output] = process.argv.slice(2);
if (worktree === undefined || output === undefined) {
  console.error("usage: bun bench/seed.ts <api worktree> <output db path>");
  process.exit(2);
}

// The worktree is a trusted checkout of this project's own repository.
const dbModule = (await import(pathToFileURL(`${worktree}/src/db.ts`).href)) as DbModule;
const serviceModule = (await import(
  pathToFileURL(`${worktree}/src/service.ts`).href
)) as ServiceModule;

const now = Date.now();
const db = dbModule.openDb(output);
const service = serviceModule.createService(db, { now: () => now });
service.upsertChecks(JSON.parse(checksFileJson()).checks);

const insert = db.prepare(
  "INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, attempts) VALUES (?, ?, 'up', 200, 5, NULL, 'default', 1)",
);
const perCheck = SEED_DAYS * 24 * 60;
db.run("BEGIN");
for (const id of checkIds()) {
  for (let k = 0; k < perCheck; k++) insert.run(id, now - k * MINUTE);
}
db.run("COMMIT");
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`seeded ${SEED_CHECKS * perCheck} results (check interval ${CHECK_INTERVAL_MS} ms)`);
