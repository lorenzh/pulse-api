import { loadChecks } from "./config.ts";
import { openDb } from "./db.ts";
import { createService } from "./service.ts";
import { createApiServer } from "./server.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PULSE_DB ?? "./pulse.db";
const checksFile = process.env.PULSE_CHECKS_FILE ?? "./checks.json";

const checks = loadChecks(checksFile);
const service = createService(openDb(dbPath));
service.upsertChecks(checks);

createApiServer(service).listen(port, () => {
  console.log(`pulse-api listening on :${port} (${checks.length} checks from ${checksFile}, db ${dbPath})`);
});
