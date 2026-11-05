import type { Check } from "@lorenzh/pulse-contract";
import type { CheckDefinition } from "./check-store.ts";

export type CheckSource = "file" | "database";

/** The checks that run: the applied file wins over a database definition with the same id. */
export interface EffectiveChecks {
  /** File checks in file order, then unshadowed database checks in creation order. */
  checks: Check[];
  /** Source of each effective check id. */
  sources: Map<string, CheckSource>;
  /** Database definitions whose id the applied file also has; stored, but not run. */
  shadowed: CheckDefinition[];
  /** Hex SHA-256 of the ping secret per effective heartbeat check id. */
  heartbeatDigests: Map<string, string>;
}

export interface FileChecks {
  checks: Check[];
  /** Hex SHA-256 of the ping secret per heartbeat check id of the file. */
  secretDigests: ReadonlyMap<string, string>;
}

/** Merge the applied file checks and the database definitions into the effective set. */
export function effectiveChecks(
  file: FileChecks,
  definitions: readonly CheckDefinition[],
): EffectiveChecks {
  const checks: Check[] = [];
  const sources = new Map<string, CheckSource>();
  const heartbeatDigests = new Map<string, string>();
  for (const check of file.checks) {
    checks.push(check);
    sources.set(check.id, "file");
    const digest = file.secretDigests.get(check.id);
    if (check.type === "heartbeat" && digest !== undefined) heartbeatDigests.set(check.id, digest);
  }
  const shadowed: CheckDefinition[] = [];
  for (const definition of definitions) {
    const { check, secretSha256 } = definition;
    if (sources.has(check.id)) {
      shadowed.push(definition);
      continue;
    }
    checks.push(check);
    sources.set(check.id, "database");
    if (check.type === "heartbeat" && secretSha256 !== null) {
      heartbeatDigests.set(check.id, secretSha256);
    }
  }
  return { checks, sources, shadowed, heartbeatDigests };
}
