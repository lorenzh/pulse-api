import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { parseRetentionDays, startRetention } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PULSE_DB ?? "./pulse.db";
const checksFile = process.env.PULSE_CHECKS_FILE ?? "./checks.json";
const retentionDays = parseRetentionDays(process.env.PULSE_RETENTION_DAYS);

const { checks, maintenance } = loadConfig(checksFile);
const service = createService(openDb(dbPath), { maintenance });
service.upsertChecks(checks);

startRetention({
  service,
  now: Date.now,
  retentionDays,
  sleep: (ms) => sleep(ms),
  // Unref'd so a pending hourly run does not block shutdown.
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  log: console.log,
});

createApiServer(service).listen(port, () => {
  console.log(
    `pulse-api listening on :${port} (${checks.length} checks, ${maintenance.length} maintenance windows from ${checksFile}, db ${dbPath}, retention ${retentionDays} days)`,
  );
});
