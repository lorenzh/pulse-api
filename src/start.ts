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
import { createAdminAuthFailures } from "./admin-auth-failures.ts";
import { createAdminHandler } from "./admin-routes.ts";
import type { AdminToken } from "./admin-tokens.ts";
import { createPendingAudit } from "./audit-log.ts";
import { componentBudgets } from "./components.ts";
import { ConfigError, loadAdminTokens, loadTokens } from "./config.ts";
import { nodeConfigFs } from "./config-fs.ts";
import { createConfigHolder } from "./config-holder.ts";
import type { ReloadFs } from "./config-reload.ts";
import { createConfigReloader, loadInitialConfig, startConfigPolling } from "./config-reload.ts";
import type { WriteFs } from "./config-write.ts";
import { createConfigWriter } from "./config-write.ts";
import { createHeartbeatEvaluator, startHeartbeatEvaluator } from "./heartbeat.ts";
import { startLatencyRollup } from "./latency-rollup.ts";
import { readLocationSilentMs } from "./location-silence.ts";
import { createManualIncidentStore } from "./manual-incidents.ts";
import { createMetrics } from "./metrics.ts";
import { readRetentionDays, startRetention } from "./retention.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { openTokenStore, readBootstrap } from "./token-import.ts";
import { isActive } from "./token-scopes.ts";
import { generateSecret, generateTokenId, type TokenStore } from "./token-store.ts";
import { type ProbeToken, TokensError } from "./tokens.ts";
import { startUptimeRollup } from "./uptime-rollup.ts";

export const SHUTDOWN_TIMEOUT_MS = 5000;

/** The shutdown hit its bound: open connections were closed, cleanup and the database close ran. */
export class ShutdownTimeoutError extends Error {
  override name = "ShutdownTimeoutError";
  constructor(timeoutMs: number) {
    super(`shutdown did not finish within ${timeoutMs}ms`);
  }
}
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
  /** New token secrets; defaults to `generateSecret`. A test hook. */
  generateSecret?: () => string;
  /** New token ids; defaults to `generateTokenId`. A test hook. */
  generateTokenId?: () => string;
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

/** Run `fn`; a TokensError gets the setting and the path appended. */
function withFile<T>(setting: string, file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (!(err instanceof TokensError)) throw err;
    throw new TokensError(`${err.message} (${setting}=${file})`, { cause: err });
  }
}

interface TokenFiles {
  tokensFile: string;
  adminTokensFile: string | undefined;
}

const IGNORED = "ignored: tokens are stored in the database";

/**
 * D5 steps 3 to 5: read the bootstrap rows, open only the files of pending imports, import them in
 * one transaction, then build the store. A file whose import is done is never opened.
 */
function bootstrapTokens(
  deps: StartDeps,
  db: Database,
  files: TokenFiles,
  info: (message: string) => void,
): { store: TokenStore; isAdminEnabled: boolean } {
  const { env } = deps;
  const done = readBootstrap(db);
  let probe: ProbeToken[] | undefined;
  let admin: AdminToken[] | undefined;
  if (done.isProbeDone) {
    if (readString(env, "PULSE_TOKENS_FILE") !== undefined) info(`PULSE_TOKENS_FILE ${IGNORED}`);
  } else {
    probe = withFile("PULSE_TOKENS_FILE", files.tokensFile, () => loadTokens(files.tokensFile));
  }
  const adminFile = files.adminTokensFile;
  if (done.isAdminDone) {
    if (adminFile !== undefined) info(`PULSE_API_ADMIN_TOKENS_FILE ${IGNORED}`);
  } else if (adminFile !== undefined) {
    admin = withFile("PULSE_API_ADMIN_TOKENS_FILE", adminFile, () => loadAdminTokens(adminFile));
  }
  const store = withFile("PULSE_API_ADMIN_TOKENS_FILE", adminFile ?? "", () =>
    openTokenStore(
      {
        db,
        now: deps.now,
        generateId: deps.generateTokenId ?? generateTokenId,
        generateSecret: deps.generateSecret ?? generateSecret,
      },
      { probe, admin },
    ),
  );
  return { store, isAdminEnabled: done.isAdminDone || admin !== undefined };
}

/** The token counts of the startup line, from the database. */
function tokenCounts(store: TokenStore, at: number) {
  const active = store.list().filter((t) => isActive(t, at));
  const probe = active.filter((t) => t.scopes.includes("probe"));
  return {
    probeTokens: probe.length,
    locations: new Set(probe.map((t) => t.location)).size,
    adminTokens: active.length - probe.length,
  };
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
  let db: Database;
  try {
    db = deps.openDb(dbPath, (line) => logger.info(line));
  } catch (err) {
    throw new StartupError(`cannot open database ${dbPath} (PULSE_DB): ${errorText(err)}`, {
      cause: err,
    });
  }
  onDb(db);
  const { store: tokenStore, isAdminEnabled } = bootstrapTokens(
    deps,
    db,
    { tokensFile, adminTokensFile },
    (line) => logger.info(line),
  );

  const metrics = createMetrics({
    listStates: () => service.listCheckStates(),
    listLocations: () => service.listLocations(),
    listBudgets: () => ({
      checks: service
        .listChecks()
        .flatMap((c) =>
          c.slo?.budgetRemaining == null
            ? []
            : [{ id: c.id, budgetRemaining: c.slo.budgetRemaining }],
        ),
      components: componentBudgets(holder.get().components, service.getSloDays),
    }),
  });
  const service = createService(db, {
    now: deps.now,
    maintenance: () => holder.get().maintenance,
    availabilityTargets: () =>
      new Map(
        holder
          .get()
          .checks.flatMap((c) =>
            c.availabilityTarget === undefined ? [] : [[c.id, c.availabilityTarget] as const],
          ),
      ),
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
    deleteLatencyRollups: (cutoff) => service.deleteExpiredLatency(cutoff),
    deleteUptimeRollups: (cutoff) => service.deleteExpiredUptime(cutoff),
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
    pending: createPendingAudit(db),
    now: deps.now,
    warn: (line) => logger.warn(line),
  });
  // Before listen: a pending entry of an earlier run is decided by its temp file (D8).
  writer.resolvePending();
  const info = (message: string, fields: Record<string, string>): void =>
    logger.info(message, fields);
  const warn = (message: string, fields: Record<string, string>): void =>
    logger.warn(message, fields);
  // One recorder for /admin/* and the manual-incident writes: one rate limit, one counter.
  const authFailures = createAdminAuthFailures({ now: deps.now, warn, metrics });
  const adminHandler = createAdminHandler({
    writer,
    metrics,
    tokens: tokenStore,
    now: deps.now,
    info,
    warn,
    authFailures,
  });

  let isShuttingDown = false;
  const server = createApiServer(service, {
    tokenStore,
    isAdminEnabled,
    heartbeatSecrets: () => holder.get().secrets,
    components: () => holder.get().components,
    manualIncidents,
    ...(isAdminEnabled ? { admin: adminHandler } : {}),
    adminAuthFailures: authFailures,
    info,
    warn,
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
  const counts = tokenCounts(tokenStore, deps.now());
  logger.info("listening", {
    port: boundPort,
    checks: checks.length,
    maintenanceWindows: maintenance.length,
    components: components.length,
    checksFile,
    db: dbPath,
    retentionDays,
    ...counts,
    tokensFile,
    tokenStore: "database",
    manualIncidents: isAdminEnabled ? "writable" : "off",
    locationSilentMs: locationSilentMs ?? "auto",
    reloadIntervalMs,
    configWrites: isAdminEnabled ? "on" : "off",
  });

  // Created only after listen: the backfill must not run inside the startup work.
  const latencyRollup = startLatencyRollup({
    service,
    sleep: deps.sleep,
    now: deps.now,
    ...(deps.retentionIntervalMs === undefined ? {} : { intervalMs: deps.retentionIntervalMs }),
    setTimeout: (fn, ms) => deps.setTimeout(() => void fn(), ms),
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.info(line),
  });
  const uptimeRollup = startUptimeRollup({
    service,
    sleep: deps.sleep,
    now: deps.now,
    ...(deps.retentionIntervalMs === undefined ? {} : { intervalMs: deps.retentionIntervalMs }),
    setTimeout: (fn, ms) => deps.setTimeout(() => void fn(), ms),
    clearTimeout: deps.clearTimeout,
    log: (line) => logger.info(line),
  });

  const timeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;
    // Stop the timers first, so no run starts while the server drains.
    const retentionEnded = Promise.all([
      retention.stop(),
      latencyRollup.stop(),
      uptimeRollup.stop(),
    ]).then(() => undefined);
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
    // Unpersisted last-used values go to disk before the close (D4).
    tokenStore.flush();
    // `true` finalizes the prepared statements first. Without it SQLite keeps the connection open
    // until exit, so the WAL is not checkpointed and -wal and -shm stay next to the file.
    db.close(true);
    logger.info("stopped");
    if (outcome === "timeout") throw new ShutdownTimeoutError(timeoutMs);
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
