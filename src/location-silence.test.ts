import { expect, test } from "bun:test";
import { readLocationSilentMs } from "./location-silence.ts";

test("PULSE_LOCATION_SILENT_MS: unset or blank is undefined, a positive integer is read", () => {
  expect(readLocationSilentMs({})).toBeUndefined();
  expect(readLocationSilentMs({ PULSE_LOCATION_SILENT_MS: " " })).toBeUndefined();
  expect(readLocationSilentMs({ PULSE_LOCATION_SILENT_MS: "60000" })).toBe(60000);
  expect(readLocationSilentMs({ PULSE_LOCATION_SILENT_MS: String(2 ** 31 - 1) })).toBe(2 ** 31 - 1);
});

test("PULSE_LOCATION_SILENT_MS: zero, negative, fractional, text and over the cap fail", () => {
  for (const value of ["0", "-5", "1.5", "soon", String(2 ** 31)]) {
    expect(() => readLocationSilentMs({ PULSE_LOCATION_SILENT_MS: value })).toThrow(
      "PULSE_LOCATION_SILENT_MS",
    );
  }
});
