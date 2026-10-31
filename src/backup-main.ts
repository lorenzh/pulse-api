import { BackupError, runBackup } from "./backup.ts";

// Entry of `bun run backup <target-file>`: one line on stdout, or one line on stderr and exit 1 or 2.
try {
  process.stdout.write(`${runBackup(process.argv.slice(2), process.env, process.pid)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pulse-api backup: ${message}\n`);
  process.exitCode = err instanceof BackupError ? err.exitCode : 1;
}
