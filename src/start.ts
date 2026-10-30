import type { Database } from "bun:sqlite";
import type { AddressInfo } from "node:net";
import {
  createLogger,
  type LogLevel,
  readLogLevel,
  readPort,
  readString,
  StartupError,
} from "@lorenzh/pulse-kit";
import { assertDistinctFromProbeTokens } from "./admin-tokens.ts";
import { ConfigError, loadAdminTokens, loadConfig, loadTokens } from "./config.ts";
import { createHeartbeatEvaluator, startHeartbeatEvaluator } from "./heartbeat.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { readRetentionDays, startRetention } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { TokensError } from "./tokens.ts";

export const SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 3000;

export interface StartDeps {
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Receives one JSON log line without the newline. */
  write: (level: LogLevel, line: string) => void;
  openDb: (path: string) => Database;
  /** Bound for the shutdown; defaults to SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number;
  /** Time between retention runs; a test hook, the production interval is fixed at one hour. */
  retentionIntervalMs?: number;
}

export interface RunningApi {
  port: number;
  /** Stop the API: unready, stop accepting work, close the database. Repeated calls share one run. */
  close(): Promise<void>;
}

function isConfigFailure(err: unknown): err is Error {
  return err instanceof ConfigError || err instanceof TokensError;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/** Load the configuration, open the database and listen. Every configuration error is a StartupError. */
export async function startApi(deps: StartDeps): Promise<RunningApi> {
  let db: Database | undefined;
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

async function run(deps: StartDeps, onDb: (db: Database) => void): Promise<RunningApi> {
  const { env } = deps;
  const logger = createLogger({
    level: readLogLevel(env),
    now: deps.now,
    write: deps.write,
  });
  const port = readPort(env, "PORT", { fallback: DEFAULT_PORT }) ?? DEFAULT_PORT;
  const dbPath = readString(env, "PULSE_DB") ?? "./pulse.db";
  const checksFile = readString(env, "PULSE_CHECKS_FILE") ?? "./checks.json";
  const tokensFile = readString(env, "PULSE_TOKENS_FILE") ?? "./tokens.json";
  const adminTokensFile = readString(env, "PULSE_API_ADMIN_TOKENS_FILE");
  const retentionDays = readRetentionDays(env);
  const { checks, secrets, maintenance, components } = loadConfig(checksFile);
  let tokens: ReturnType<typeof loadTokens>;
  try {
    tokens = loadTokens(tokensFile);
  } catch (err) {
    if (!(err instanceof TokensError)) throw err;
    throw new TokensError(`${err.message} (PULSE_TOKENS_FILE=${tokensFile})`, { cause: err });
  }
  let adminTokens: ReturnType<typeof loadAdminTokens> | undefined;
  if (adminTokensFile !== undefined) {
    try {
      adminTokens = loadAdminTokens(adminTokensFile);
      assertDistinctFromProbeTokens(adminTokens, tokens);
    } catch (err) {
      if (!(err instanceof TokensError)) throw err;
      throw new TokensError(`${err.message} (PULSE_API_ADMIN_TOKENS_FILE=${adminTokensFile})`, {
        cause: err,
      });
    }
  }

  let db: Database;
  try {
    db = deps.openDb(dbPath);
  } catch (err) {
    throw new StartupError(`cannot open database ${dbPath} (PULSE_DB): ${errorText(err)}`, {
      cause: err,
    });
  }
  onDb(db);

  const metrics = createMetrics({ listStates: () => service.listCheckStates() });
  const service = createService(db, {
    maintenance,
    log: (line) => logger.info(line),
    onIncident: (event) => metrics.recordIncident(event),
  });
  service.upsertChecks(checks);
  const manualIncidents = createManualIncidentStore(db, {
    now: deps.now,
    componentIds: new Set(components.map((c) => c.id)),
    onEvent: (event) => metrics.recordManualIncident(event),
  });

  const retention = startRetention({
    service,
    now: deps.now,
    retentionDays,
    sleep: deps.sleep,
    ...(deps.retentionIntervalMs === undefined ? {} : { intervalMs: deps.retentionIntervalMs }),
    setTimeout: (fn, ms) => deps.setTimeout(() => void fn(), ms),
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.info(line),
    deleteManualIncidents: (cutoff) => manualIncidents.deleteResolvedBefore(cutoff),
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
    components,
    manualIncidents,
    ...(adminTokens === undefined ? {} : { adminTokens: adminTokens.map((t) => t.token) }),
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
    await retention.stop();
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
    components: components.length,
    checksFile,
    db: dbPath,
    retentionDays,
    probeTokens: tokens.length,
    locations: new Set(tokens.map((t) => t.location)).size,
    tokensFile,
    manualIncidents: adminTokens === undefined ? "off" : "writable",
    adminTokens: adminTokens?.length ?? 0,
  });

  const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;
    // Stop both timers first, so no run starts while the server drains.
    const retentionEnded = retention.stop();
    heartbeat.stop();
    const drained = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }).then(() => retentionEnded);
    const outcome = await Promise.race([
      drained.then(() => "drained" as const),
      deps.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      logger.warn("shutdown bound reached: closing open connections", { timeoutMs });
      server.closeAllConnections();
      // A batch is synchronous: the run ends right after the batch in progress.
      retention.abort();
    }
    // The database closes only after the run in progress has ended, so nothing writes after close.
    await retentionEnded;
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
