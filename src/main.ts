import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, type Logger, readLogLevel, runService } from "@lorenzh/pulse-kit";
import { openDb } from "./db.ts";
import { type RunningApi, SHUTDOWN_TIMEOUT_MS, startApi } from "./start.ts";

// Extra time over the bound inside the API, which closes open connections itself.
const SHUTDOWN_BACKSTOP_MS = 1000;

/** A logger for the shutdown lines. An invalid level is reported by startApi, so fall back here. */
function shutdownLogger(): Logger {
  try {
    return createLogger({ level: readLogLevel(process.env) });
  } catch {
    // startApi reports the invalid PULSE_LOG_LEVEL as a startup error.
    return createLogger();
  }
}

let running: RunningApi | undefined;

await runService({
  service: "api",
  log: shutdownLogger(),
  timeoutMs: SHUTDOWN_TIMEOUT_MS + SHUTDOWN_BACKSTOP_MS,
  start: async () => {
    running = await startApi({
      env: process.env,
      now: Date.now,
      sleep: (ms) => sleep(ms),
      // Unref'd so a pending hourly run does not block shutdown.
      // The run catches and logs its own errors, so the returned promise never rejects.
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      write: (level, line) => {
        if (level === "warn" || level === "error") process.stderr.write(`${line}\n`);
        else process.stdout.write(`${line}\n`);
      },
      openDb: (path, log) => openDb(path, undefined, log),
    });
  },
  stop: async () => {
    await running?.close();
  },
});
