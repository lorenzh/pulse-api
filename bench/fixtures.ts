// Fixture files of the bench stack, generated from the load constants so they cannot drift.
import { benchTokens, CHECK_INTERVAL_MS, checkIds } from "./load.ts";

/** The checks file of the api and the source of the seeded checks. The probe runs these. */
export function checksFileJson(): string {
  const checks = checkIds().map((id, i) => ({
    id,
    name: `Bench ${i}`,
    url: `http://bench-target:8080/${i}`,
    intervalMs: CHECK_INTERVAL_MS,
    timeoutMs: 2000,
  }));
  return JSON.stringify({ checks }, null, 2);
}

/** The tokens file of the api: the simulated probes and the real probe. */
export function tokensFileJson(): string {
  const { simulated, real } = benchTokens();
  return JSON.stringify({ tokens: [...simulated, real] }, null, 2);
}
