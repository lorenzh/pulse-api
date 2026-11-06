import { createHash } from "node:crypto";
import type { CheckDefinition } from "./check-store.ts";
import type { Config } from "./config.ts";
import { effectiveChecks } from "./effective-checks.ts";
import { type EffectiveMaintenance, effectiveMaintenance } from "./effective-maintenance.ts";
import type { WindowDefinition } from "./maintenance-store.ts";

/**
 * The configuration in use. A reload, an admin write or a database check write swaps one part in
 * one step; `get` serves the applied file with the effective checks of both sources.
 */
export interface ConfigHolder {
  /**
   * The applied file, with its checks replaced by the effective checks and its windows by the
   * effective windows. The same object until the next setter call.
   */
  get(): Config;
  /** The applied file as parsed. */
  file(): Config;
  /** The stored database definitions in creation order. */
  definitions(): readonly CheckDefinition[];
  /** The stored database windows in creation order. */
  windowDefinitions(): readonly WindowDefinition[];
  /** The effective and shadowed database windows of the current set. */
  maintenance(): EffectiveMaintenance;
  /** Hex SHA-256 of the ping secret per heartbeat check id of the applied file. */
  fileDigests(): ReadonlyMap<string, string>;
  /** Hex SHA-256 of the ping secret per effective heartbeat check id, of both sources. */
  heartbeatDigests(): ReadonlyMap<string, string>;
  /** The effective checks of a file with the current definitions; changes nothing. */
  checksWith(file: Config): Config["checks"];
  /** `digests` defaults to the digests of `next.secrets`; a snapshot has digests only. */
  set(next: Config, digests?: ReadonlyMap<string, string>): void;
  setDefinitions(next: readonly CheckDefinition[]): void;
  setWindowDefinitions(next: readonly WindowDefinition[]): void;
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
  initialWindows: readonly WindowDefinition[] = [],
): ConfigHolder {
  let windowDefinitions = initialWindows;
  let file = initial;
  let digests = initialDigests;
  let definitions = initialDefinitions;
  const checksWith = (next: Config): Config["checks"] =>
    effectiveChecks({ checks: next.checks, secretDigests: new Map() }, definitions).checks;
  const merge = () => effectiveChecks({ checks: file.checks, secretDigests: digests }, definitions);
  // Computed once per change: the service reads the windows for every result.
  const project = (): EffectiveMaintenance =>
    effectiveMaintenance(
      file.maintenance,
      windowDefinitions,
      new Set(merged.checks.map((c) => c.id)),
    );
  let merged = merge();
  let windows = project();
  let current: Config = { ...file, checks: merged.checks, maintenance: windows.windows };
  const refresh = (): void => {
    merged = merge();
    windows = project();
    current = { ...file, checks: merged.checks, maintenance: windows.windows };
  };
  return {
    get: () => current,
    file: () => file,
    definitions: () => definitions,
    windowDefinitions: () => windowDefinitions,
    maintenance: () => windows,
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
    setWindowDefinitions(next) {
      windowDefinitions = next;
      refresh();
    },
  };
}
