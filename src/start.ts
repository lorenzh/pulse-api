import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  createLogger,
  type LogLevel,
  readLogLevel,
  readMs,
  readPort,
  readString,
  StartupError,
} from "@lorenzh/pulse-kit";
import { createAdminHandler } from "./admin-routes.ts";
import { assertDistinctFromProbeTokens } from "./admin-tokens.ts";
import { ConfigError, loadAdminTokens, loadTokens } from "./config.ts";
import { nodeConfigFs } from "./config-fs.ts";
import { createConfigHolder } from "./config-holder.ts";
import type { ReloadFs } from "./config-reload.ts";
import { createConfigReloader, loadInitialConfig, startConfigPolling } from "./config-reload.ts";
import type { WriteFs } from "./config-write.ts";
import { createConfigWriter } from "./config-write.ts";
import { createHeartbeatEvaluator, startHeartbeatEvaluator } from "./heartbeat.ts";
import { readLocationSilentMs } from "./location-silence.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { readRetentionDays, startRetention } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { matchesAnyToken, TokensError } from "./tokens.ts";

export const SHUTDOWN_TIMEOUT_MS = 5000;
export const DEFAULT_CHECKS_RELOAD_INTERVAL_MS = 5000;
const DEFAULT_PORT = 3000;
const MIN_RELOAD_INTERVAL_MS = 1000;
const MAX_RELOAD_INTERVAL_MS = 3_600_000;

export interface StartDeps {
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Receives one JSON log line without the newline. */
  write: (level: LogLevel, line: string) => void;
  /** Opens the database; `log` receives migration notes. */
  openDb: (path: string, log: (line: string) => void) => Database;
  /** Bound for the shutdown; defaults to SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number;
  /** Registers a handler for SIGHUP and returns the function that removes it. Without it SIGHUP is not handled. */
  onSignal?: (signal: "SIGHUP", handler: () => void) => () => void;
  /** File operations on the checks file; defaults to the real ones. */
  configFs?: ReloadFs & WriteFs;
  /** Unique part of the temp file name of an admin write; defaults to a random one. */
  tempSuffix?: () => string;
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

const RELOAD_RULE = "must be 0 (off) or an integer from 1000 to 3600000 (milliseconds)";

/** Read `PULSE_CHECKS_RELOAD_INTERVAL_MS`: 0 turns polling off. */
function readReloadIntervalMs(env: StartDeps["env"]): number {
  const value = readMs(env, "PULSE_CHECKS_RELOAD_INTERVAL_MS", {
    fallback: DEFAULT_CHECKS_RELOAD_INTERVAL_MS,
    min: 0,
    max: MAX_RELOAD_INTERVAL_MS,
    describe: RELOAD_RULE,
  });
  if (value !== 0 && value < MIN_RELOAD_INTERVAL_MS) {
    throw new StartupError(`PULSE_CHECKS_RELOAD_INTERVAL_MS: ${RELOAD_RULE}`, {
      setting: "PULSE_CHECKS_RELOAD_INTERVAL_MS",
    });
  }
  return value;
}

function readAdminTokens(
  file: string,
  probeTokens: ReturnType<typeof loadTokens>,
): ReturnType<typeof loadAdminTokens> {
  try {
    const admin = loadAdminTokens(file);
    assertDistinctFromProbeTokens(admin, probeTokens);
    return admin;
  } catch (err) {
    if (!(err instanceof TokensError)) throw err;
    throw new TokensError(`${err.message} (PULSE_API_ADMIN_TOKENS_FILE=${file})`, { cause: err });
  }
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
  const locationSilentMs = readLocationSilentMs(env);
  const reloadIntervalMs = readReloadIntervalMs(env);
  const configFs = deps.configFs ?? nodeConfigFs;
  const initial = loadInitialConfig(configFs, checksFile);
  const holder = createConfigHolder(initial.config);
  const { checks, maintenance, components } = initial.config;
  let tokens: ReturnType<typeof loadTokens>;
  try {
    tokens = loadTokens(tokensFile);
  } catch (err) {
    if (!(err instanceof TokensError)) throw err;
    throw new TokensError(`${err.message} (PULSE_TOKENS_FILE=${tokensFile})`, { cause: err });
  }
  const adminTokens =
    adminTokensFile === undefined ? undefined : readAdminTokens(adminTokensFile, tokens);

  let db: Database;
  try {
    db = deps.openDb(dbPath, (line) => logger.info(line));
  } catch (err) {
    throw new StartupError(`cannot open database ${dbPath} (PULSE_DB): ${errorText(err)}`, {
      cause: err,
    });
  }
  onDb(db);

  const metrics = createMetrics({
    listStates: () => service.listCheckStates(),
    listLocations: () => service.listLocations(),
  });
  const service = createService(db, {
    maintenance: () => holder.get().maintenance,
    ...(locationSilentMs === undefined ? {} : { locationSilentMs }),
    log: (line) => logger.info(line),
    onIncident: (event) => metrics.recordIncident(event),
  });
  service.upsertChecks(checks);
  const manualIncidents = createManualIncidentStore(db, {
    now: deps.now,
    componentIds: () => new Set(holder.get().components.map((c) => c.id)),
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

  const reloader = createConfigReloader(
    {
      path: checksFile,
      fs: configFs,
      onApply: (next) => {
        // SQLite first, in one transaction: a failed update leaves the holder and revision as they were.
        service.upsertChecks(next.checks);
        holder.set(next);
      },
      log: (line) => logger.warn(line),
      metrics,
    },
    initial,
  );
  const polling = startConfigPolling({
    reloader,
    intervalMs: reloadIntervalMs,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.warn(line),
  });
  const removeSignal = deps.onSignal?.("SIGHUP", () => reloader.reloadNow());
  const writer = createConfigWriter({
    path: checksFile,
    fs: configFs,
    holder,
    reloader,
    tempSuffix: deps.tempSuffix ?? (() => `${process.pid}-${randomBytes(6).toString("hex")}`),
    hasOpenIncidentFor: (id) => manualIncidents.hasOpenIncidentFor(id),
  });
  const adminHandler = (list: ReturnType<typeof loadAdminTokens>) =>
    createAdminHandler({
      writer,
      metrics,
      adminTokens: new Map(list.map((t) => [t.token, t.name])),
      isProbeToken: (header) =>
        matchesAnyToken(
          tokens.map((t) => t.token),
          header,
        ),
      info: (message, fields) => logger.info(message, fields),
      warn: (message, fields) => logger.warn(message, fields),
    });

  let isShuttingDown = false;
  const server = createApiServer(service, {
    tokens,
    heartbeatSecrets: () => holder.get().secrets,
    components: () => holder.get().components,
    manualIncidents,
    ...(adminTokens === undefined
      ? {}
      : { adminTokens: adminTokens.map((t) => t.token), admin: adminHandler(adminTokens) }),
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
    polling.stop();
    removeSignal?.();
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
    locationSilentMs: locationSilentMs ?? "auto",
    reloadIntervalMs,
    configWrites: adminTokens === undefined ? "off" : "on",
  });

  const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;
    // Stop both timers first, so no run starts while the server drains.
    const retentionEnded = retention.stop();
    heartbeat.stop();
    polling.stop();
    removeSignal?.();
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
