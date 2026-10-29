import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { ConfigError, loadConfig, loadTokens } from "./config.ts";
import { createHeartbeatEvaluator, startHeartbeatEvaluator } from "./heartbeat.ts";
import { createLogger, type LogLevel, LogLevelError, parseLogLevel } from "./log.ts";
import { createMetrics } from "./metrics.ts";
import { parseRetentionDays, RetentionConfigError, startRetention } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { TokensError } from "./tokens.ts";

export const SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

/** A configuration or startup failure: the process prints `pulse-api: <message>` and exits with 2. */
export class StartupError extends Error {
  override name = "StartupError";
}

export interface StartDeps {
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Receives one JSON log line without the newline. */
  write: (line: string, level: LogLevel) => void;
  openDb: (path: string) => DatabaseSync;
  /** Bound for the shutdown; defaults to SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number;
}

export interface RunningApi {
  port: number;
  /** Stop the API: unready, stop accepting work, close the database. Repeated calls share one run. */
  close(): Promise<void>;
}

export function parsePort(raw: string | undefined): number {
  const text = raw?.trim() ?? "";
  if (text === "") return DEFAULT_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > MAX_PORT) {
    throw new StartupError(`PORT must be an integer from 0 to ${MAX_PORT}, got "${text}"`);
  }
  return port;
}

function isConfigFailure(err: unknown): err is Error {
  return (
    err instanceof ConfigError ||
    err instanceof RetentionConfigError ||
    err instanceof TokensError ||
    err instanceof LogLevelError
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/** Load the configuration, open the database and listen. Every configuration error is a StartupError. */
export async function startApi(deps: StartDeps): Promise<RunningApi> {
  let db: DatabaseSync | undefined;
  try {
    return await run(deps, (opened) => {
      db = opened;
    });
  } catch (err) {
    db?.close();
    if (isConfigFailure(err)) throw new StartupError(err.message, { cause: err });
    throw err;
  }
}

async function run(deps: StartDeps, onDb: (db: DatabaseSync) => void): Promise<RunningApi> {
  const { env } = deps;
  const logger = createLogger({
    level: parseLogLevel(env.PULSE_LOG_LEVEL),
    now: deps.now,
    write: deps.write,
  });
  const port = parsePort(env.PORT);
  const dbPath = env.PULSE_DB ?? "./pulse.db";
  const checksFile = env.PULSE_CHECKS_FILE ?? "./checks.json";
  const tokensFile = env.PULSE_TOKENS_FILE ?? "./tokens.json";
  const retentionDays = parseRetentionDays(env.PULSE_RETENTION_DAYS);
  const { checks, secrets, maintenance } = loadConfig(checksFile);
  const tokens = loadTokens(tokensFile);

  let db: DatabaseSync;
  try {
    db = deps.openDb(dbPath);
  } catch (err) {
    throw new StartupError(`cannot open database ${dbPath} (PULSE_DB): ${errorText(err)}`, {
      cause: err,
    });
  }
  onDb(db);

  const metrics = createMetrics();
  const service = createService(db, {
    maintenance,
    log: (line) => logger.info(line),
    onIncident: (event) => metrics.recordIncident(event),
  });
  service.upsertChecks(checks);

  const retention = startRetention({
    service,
    now: deps.now,
    retentionDays,
    sleep: deps.sleep,
    setTimeout: (fn, ms) => deps.setTimeout(() => void fn(), ms),
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.info(line),
  });

  const heartbeat = startHeartbeatEvaluator({
    evaluator: createHeartbeatEvaluator({ service, metrics, now: deps.now }),
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.warn(line),
  });

  let isShuttingDown = false;
  const server = createApiServer(service, {
    tokens,
    heartbeatSecrets: secrets,
    now: deps.now,
    metrics,
    notReadyReason: () => (isShuttingDown ? "shutting down" : undefined),
    logError: (msg, err) =>
      logger.error(msg, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, resolve);
    });
  } catch (err) {
    retention.stop();
    heartbeat.stop();
    throw new StartupError(`cannot listen on port ${port} (PORT): ${errorText(err)}`, {
      cause: err,
    });
  }
  const boundPort = (server.address() as AddressInfo).port;
  logger.info("listening", {
    port: boundPort,
    checks: checks.length,
    maintenanceWindows: maintenance.length,
    checksFile,
    db: dbPath,
    retentionDays,
    probeTokens: tokens.length,
    locations: new Set(tokens.map((t) => t.location)).size,
    tokensFile,
  });

  const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;
    retention.stop();
    heartbeat.stop();
    const drained = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }).then(() => retention.done);
    const outcome = await Promise.race([
      drained.then(() => "drained" as const),
      deps.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      logger.warn("shutdown bound reached: closing open connections", { timeoutMs });
      server.closeAllConnections();
    }
    db.close();
    logger.info("stopped");
  };
  let closing: Promise<void> | undefined;
  return {
    port: boundPort,
    close: () => {
      closing ??= shutdown();
      return closing;
    },
  };
}
