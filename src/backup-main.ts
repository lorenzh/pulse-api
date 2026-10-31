import { BackupError, runBackup } from "./backup.ts";

// Entry of `bun run backup <target-file>`: one line on stdout, or one line on stderr and exit 1 or 2.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const controller = new AbortController();
const onSignal = (): void => controller.abort();
for (const signal of SIGNALS) process.on(signal, onSignal);

try {
  const line = await runBackup(process.argv.slice(2), process.env, {
    pause: () => new Promise((resolve) => setImmediate(resolve)),
    signal: controller.signal,
  });
  process.stdout.write(`${line}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pulse-api backup: ${message}\n`);
  process.exitCode = err instanceof BackupError ? err.exitCode : 1;
} finally {
  for (const signal of SIGNALS) process.off(signal, onSignal);
}
