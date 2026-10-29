import { setTimeout as sleep } from "node:timers/promises";
import { openDb } from "./db.ts";
import { createLogger, type LogLevel } from "./log.ts";
import { type RunningApi, StartupError, startApi } from "./start.ts";

// Exit codes: 0 clean stop, 2 configuration or startup error, 1 unexpected failure.
const EXIT_STARTUP_ERROR = 2;
const EXIT_FAILURE = 1;

function write(line: string, level: LogLevel): void {
  if (level === "warn" || level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

// Registered before any config loading, so a signal during startup is not lost.
let running: RunningApi | undefined;
let isStopRequested = false;

async function stop(): Promise<void> {
  isStopRequested = true;
  // Without a running API there is nothing to drain: the startup in main() finishes the stop.
  if (running === undefined) return;
  await running.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

async function main(): Promise<void> {
  try {
    running = await startApi({
      env: process.env,
      now: Date.now,
      sleep: (ms) => sleep(ms),
      // Unref'd so a pending hourly run does not block shutdown.
      // The run catches and logs its own errors, so the returned promise never rejects.
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      write,
      openDb: (path) => openDb(path),
    });
  } catch (err) {
    if (err instanceof StartupError) {
      process.stderr.write(`pulse-api: ${err.message}\n`);
      process.exit(EXIT_STARTUP_ERROR);
    }
    throw err;
  }
  if (isStopRequested) await stop();
}

main().catch((err: unknown) => {
  const logger = createLogger({ level: "error", now: Date.now, write });
  logger.error("unexpected failure", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  process.exit(EXIT_FAILURE);
});
