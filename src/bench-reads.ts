// Not part of `npm test`. Usage: node src/bench-reads.ts [checks] [days]
// Seeds an in-memory database with `checks` checks and `days` days of 1-minute results,
// then prints the time of GET /checks and GET /uptime (service level, cache cleared each run).
import { openDb } from "./db.ts";
import { createService } from "./service.ts";

const checkCount = Number(process.argv[2] ?? 100);
const days = Number(process.argv[3] ?? 90);
const MINUTE = 60_000;
const now = Date.now();
const db = openDb(":memory:");
const service = createService(db, { now: () => now });
service.upsertChecks(
  Array.from({ length: checkCount }, (_, i) => ({
    id: `c${i}`,
    name: `C${i}`,
    url: `http://example.invalid/${i}`,
    intervalMs: MINUTE,
  })),
);

const insert = db.prepare(
  "INSERT INTO results (check_id, timestamp, status, status_code, latency_ms, reason, location, attempts) VALUES (?, ?, 'up', 200, 5, NULL, 'default', 1)",
);
const perCheck = days * 24 * 60;
db.exec("BEGIN");
for (let i = 0; i < checkCount; i++) {
  for (let k = 0; k < perCheck; k++) insert.run(`c${i}`, now - k * MINUTE);
}
db.exec("COMMIT");
console.log(`seeded ${checkCount * perCheck} results`);

function time(label: string, fn: () => unknown): void {
  const start = performance.now();
  fn();
  console.log(`${label}: ${(performance.now() - start).toFixed(1)} ms`);
}

time("GET /checks", () => service.listChecks());
time("GET /uptime", () => service.getUptime());
