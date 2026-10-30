import type { Config } from "./config.ts";

/** The configuration in use. A reload or an admin write swaps it in one step. */
export interface ConfigHolder {
  get(): Config;
  set(next: Config): void;
}

export function createConfigHolder(initial: Config): ConfigHolder {
  let current = initial;
  return {
    get: () => current,
    set(next) {
      current = next;
    },
  };
}
