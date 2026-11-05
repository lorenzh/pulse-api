import { createHash } from "node:crypto";
import type { CheckDefinition } from "./check-store.ts";
import type { Config } from "./config.ts";
import { effectiveChecks } from "./effective-checks.ts";

/**
 * The configuration in use. A reload, an admin write or a database check write swaps one part in
 * one step; `get` serves the applied file with the effective checks of both sources.
 */
export interface ConfigHolder {
  /** The applied file, with its checks replaced by the effective checks. */
  get(): Config;
  /** The applied file as parsed. */
  file(): Config;
  /** The stored database definitions in creation order. */
  definitions(): readonly CheckDefinition[];
  /** Hex SHA-256 of the ping secret per heartbeat check id of the applied file. */
  fileDigests(): ReadonlyMap<string, string>;
  /** Hex SHA-256 of the ping secret per effective heartbeat check id, of both sources. */
  heartbeatDigests(): ReadonlyMap<string, string>;
  /** The effective checks of a file with the current definitions; changes nothing. */
  checksWith(file: Config): Config["checks"];
  /** `digests` defaults to the digests of `next.secrets`; a snapshot has digests only. */
  set(next: Config, digests?: ReadonlyMap<string, string>): void;
  setDefinitions(next: readonly CheckDefinition[]): void;
}

/** Hex SHA-256 of each ping secret; the plaintext is not kept beside it. */
export function secretDigests(secrets: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(
    [...secrets].map(([id, secret]) => [id, createHash("sha256").update(secret).digest("hex")]),
  );
}

export function createConfigHolder(
  initial: Config,
  initialDefinitions: readonly CheckDefinition[] = [],
  initialDigests: ReadonlyMap<string, string> = secretDigests(initial.secrets),
): ConfigHolder {
  let file = initial;
  let digests = initialDigests;
  let definitions = initialDefinitions;
  const checksWith = (next: Config): Config["checks"] =>
    effectiveChecks({ checks: next.checks, secretDigests: new Map() }, definitions).checks;
  const merge = () => effectiveChecks({ checks: file.checks, secretDigests: digests }, definitions);
  let merged = merge();
  let current: Config = { ...file, checks: merged.checks };
  const refresh = (): void => {
    merged = merge();
    current = { ...file, checks: merged.checks };
  };
  return {
    get: () => current,
    file: () => file,
    definitions: () => definitions,
    fileDigests: () => digests,
    heartbeatDigests: () => merged.heartbeatDigests,
    checksWith,
    set(next, nextDigests) {
      file = next;
      digests = nextDigests ?? secretDigests(next.secrets);
      refresh();
    },
    setDefinitions(next) {
      definitions = next;
      refresh();
    },
  };
}
