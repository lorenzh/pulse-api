// Fixture files of the bench stack, generated from the load constants so they cannot drift.
import { AVAILABILITY_TARGET, benchTokens, CHECK_INTERVAL_MS, checkIds } from "./load.ts";

function benchChecks() {
  return checkIds().map((id, i) => ({
    id,
    name: `Bench ${i}`,
    url: `http://bench-target:8080/${i}`,
    intervalMs: CHECK_INTERVAL_MS,
    timeoutMs: 2000,
    availabilityTarget: AVAILABILITY_TARGET,
  }));
}

/** The checks file of the api and the source of the seeded checks. The probe runs these. */
export function checksFileJson(): string {
  return JSON.stringify({ checks: benchChecks() }, null, 2);
}

/**
 * The two components of the end-of-day phase and of `today-parity.ts`: checks 0-9 and 10-19.
 * Each has the bench availability target, so `/components` builds an `slo` too.
 */
export function eodComponents(): {
  id: string;
  name: string;
  checkIds: string[];
  availabilityTarget: number;
}[] {
  const ids = checkIds();
  return [
    {
      id: "first",
      name: "First",
      checkIds: ids.slice(0, 10),
      availabilityTarget: AVAILABILITY_TARGET,
    },
    {
      id: "second",
      name: "Second",
      checkIds: ids.slice(10),
      availabilityTarget: AVAILABILITY_TARGET,
    },
  ];
}

/** The checks file of the end-of-day phase: the bench checks plus `eodComponents`. */
export function eodChecksFileJson(): string {
  return JSON.stringify({ checks: benchChecks(), components: eodComponents() }, null, 2);
}

/** The tokens file of the api: the simulated probes and the real probe. */
export function tokensFileJson(): string {
  const { simulated, real } = benchTokens();
  return JSON.stringify({ tokens: [...simulated, real] }, null, 2);
}
