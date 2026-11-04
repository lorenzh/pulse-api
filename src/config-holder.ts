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
  /** The effective checks of a file with the current definitions; changes nothing. */
  checksWith(file: Config): Config["checks"];
  set(next: Config): void;
  setDefinitions(next: readonly CheckDefinition[]): void;
}

export function createConfigHolder(
  initial: Config,
  initialDefinitions: readonly CheckDefinition[] = [],
): ConfigHolder {
  let file = initial;
  let definitions = initialDefinitions;
  const checksWith = (next: Config): Config["checks"] =>
    effectiveChecks({ checks: next.checks, secretDigests: new Map() }, definitions).checks;
  let current: Config = { ...file, checks: checksWith(file) };
  const refresh = (): void => {
    current = { ...file, checks: checksWith(file) };
  };
  return {
    get: () => current,
    file: () => file,
    definitions: () => definitions,
    checksWith,
    set(next) {
      file = next;
      refresh();
    },
    setDefinitions(next) {
      definitions = next;
      refresh();
    },
  };
}
