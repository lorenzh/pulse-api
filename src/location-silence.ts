import { type Env, readMs, readString } from "@lorenzh/pulse-kit";

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Read `PULSE_LOCATION_SILENT_MS`: a positive integer, or undefined when unset (derived from the checks). */
export function readLocationSilentMs(env: Env): number | undefined {
  if (readString(env, "PULSE_LOCATION_SILENT_MS") === undefined) return undefined;
  return readMs(env, "PULSE_LOCATION_SILENT_MS", { fallback: 1, min: 1, max: MAX_TIMER_MS });
}
