import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PULSE_DB ?? "./pulse.db";
const checksFile = process.env.PULSE_CHECKS_FILE ?? "./checks.json";

const { checks, maintenance } = loadConfig(checksFile);
const service = createService(openDb(dbPath), { maintenance });
service.upsertChecks(checks);

createApiServer(service).listen(port, () => {
  console.log(
    `pulse-api listening on :${port} (${checks.length} checks, ${maintenance.length} maintenance windows from ${checksFile}, db ${dbPath})`,
  );
});
