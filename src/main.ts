import { loadConfig, loadTokens } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { type ProbeToken, TokensError } from "./tokens.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.PULSE_DB ?? "./pulse.db";
const checksFile = process.env.PULSE_CHECKS_FILE ?? "./checks.json";

const tokensFile = process.env.PULSE_TOKENS_FILE ?? "./tokens.json";

const { checks, maintenance } = loadConfig(checksFile);
const service = createService(openDb(dbPath), { maintenance });
service.upsertChecks(checks);

let tokens: ProbeToken[];
try {
  tokens = loadTokens(tokensFile);
} catch (err) {
  if (!(err instanceof TokensError)) throw err;
  console.error(`pulse-api: ${err.message}`);
  process.exit(1);
}
const locations = new Set(tokens.map((t) => t.location)).size;

createApiServer(service, { tokens }).listen(port, () => {
  console.log(
    `pulse-api listening on :${port} (${checks.length} checks, ${maintenance.length} maintenance windows from ${checksFile}, db ${dbPath}; ${tokens.length} probe tokens for ${locations} locations from ${tokensFile})`,
  );
});
