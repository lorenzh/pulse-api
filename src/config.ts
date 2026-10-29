import { readFileSync } from "node:fs";
import type { Check, HttpCheck, MaintenanceWindow, TlsCheck } from "@lorenzh/pulse-contract";
import { type ProbeToken, parseTokens, TokensError } from "./tokens.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

const TOP_KEYS = ["checks", "maintenance"];
const COMMON_CHECK_KEYS = ["id", "name", "type", "timeoutMs", "keyword"];
const HTTP_CHECK_KEYS = [
  ...COMMON_CHECK_KEYS,
  "url",
  "intervalMs",
  "retries",
  "retryDelayMs",
  "latencyObjectiveMs",
];
const TLS_CHECK_KEYS = [...COMMON_CHECK_KEYS, "host", "port", "warnDays", "intervalMs"];
const HEARTBEAT_CHECK_KEYS = ["id", "name", "type", "period", "grace", "secret"];
const MAINTENANCE_KEYS = ["checkId", "start", "end", "note"];

/** Reject a key a typo or a stale option leaves behind: `unknown key "keywrod" in checks[2]`. */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(raw).find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw new ConfigError(`unknown key "${unknown}" in ${where}`);
}

const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TLS_PORT = 443;
const DEFAULT_WARN_DAYS = 14;

function parseTls(raw: Record<string, unknown>, where: string, id: string, name: string): TlsCheck {
  const host = raw.host;
  if (
    !nonEmptyString(host) ||
    host !== host.trim() ||
    /[\s/\\?#@]/.test(host) ||
    host.includes("://") ||
    // a colon is only valid in a bracketless IPv6 literal, which has at least two
    (host.includes(":") && host.split(":").length < 3)
  ) {
    throw new ConfigError(`${where}.host must be a host name without scheme, port or path`);
  }
  const port = raw.port ?? DEFAULT_TLS_PORT;
  if (!(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new ConfigError(`${where}.port must be an integer from 1 to 65535`);
  }
  const warnDays = raw.warnDays ?? DEFAULT_WARN_DAYS;
  if (!positiveInt(warnDays)) {
    throw new ConfigError(`${where}.warnDays must be a positive integer (days)`);
  }
  if (!positiveInt(raw.intervalMs)) {
    throw new ConfigError(`${where}.intervalMs must be a positive integer (milliseconds)`);
  }
  return { id, name, type: "tls", host, port, warnDays, intervalMs: raw.intervalMs };
}

const MIN_HEARTBEAT_PERIOD_MS = 1000;
const MAX_HEARTBEAT_MS = 86_400_000;
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 128;
const SECRET_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** Messages never contain the secret value. */
function parseHeartbeat(
  raw: Record<string, unknown>,
  where: string,
  id: string,
  name: string,
): { check: Check; secret: string } {
  if (!intIn(raw.period, MIN_HEARTBEAT_PERIOD_MS, MAX_HEARTBEAT_MS)) {
    throw new ConfigError(
      `${where}.period must be an integer from ${MIN_HEARTBEAT_PERIOD_MS} to ${MAX_HEARTBEAT_MS} (milliseconds)`,
    );
  }
  const grace = raw.grace ?? 0;
  if (!intIn(grace, 0, MAX_HEARTBEAT_MS)) {
    throw new ConfigError(
      `${where}.grace must be an integer from 0 to ${MAX_HEARTBEAT_MS} (milliseconds)`,
    );
  }
  const secret = raw.secret;
  if (
    typeof secret !== "string" ||
    secret.length < MIN_SECRET_LENGTH ||
    secret.length > MAX_SECRET_LENGTH ||
    !SECRET_PATTERN.test(secret)
  ) {
    throw new ConfigError(
      `${where}.secret is required: ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters from A-Z a-z 0-9 . _ ~ -`,
    );
  }
  return { check: { id, name, type: "heartbeat", period: raw.period, grace }, secret };
}

export interface ParsedChecks {
  checks: Check[];
  /** Ping secret per heartbeat check id. Kept apart from the checks: it is never served. */
  secrets: Map<string, string>;
}

/** Validate a parsed checks file; throws ConfigError. */
export function parseChecks(data: unknown): Check[] {
  return parseChecksWithSecrets(data).checks;
}

/** Validate a parsed checks file and return the heartbeat secrets with it; throws ConfigError. */
export function parseChecksWithSecrets(data: unknown): ParsedChecks {
  if (!isRecord(data) || !Array.isArray(data.checks)) {
    throw new ConfigError('config must be an object with a "checks" array');
  }
  rejectUnknownKeys(data, TOP_KEYS, "the top level");
  const seen = new Set<string>();
  const checks: Check[] = [];
  const secrets = new Map<string, string>();
  // eslint-disable-next-line sonarjs/cognitive-complexity -- splitting this validator/handler would be a behaviour-risking refactor
  data.checks.forEach((raw: unknown, i: number) => {
    const where = `checks[${i}]`;
    if (!isRecord(raw)) throw new ConfigError(`${where} must be an object`);
    for (const field of ["id", "name"]) {
      if (!nonEmptyString(raw[field])) {
        throw new ConfigError(`${where}.${field} is required and must be a non-empty string`);
      }
    }
    const { id, name } = raw as { id: string; name: string };
    const type = raw.type ?? "http";
    if (type !== "http" && type !== "tls" && type !== "heartbeat") {
      throw new ConfigError(`${where}.type must be "http", "tls" or "heartbeat"`);
    }
    if (type === "heartbeat") {
      rejectUnknownKeys(raw, HEARTBEAT_CHECK_KEYS, where);
      const parsed = parseHeartbeat(raw, where, id, name);
      if (seen.has(id)) throw new ConfigError(`duplicate check id "${id}"`);
      seen.add(id);
      secrets.set(id, parsed.secret);
      checks.push(parsed.check);
      return;
    }
    rejectUnknownKeys(raw, type === "tls" ? TLS_CHECK_KEYS : HTTP_CHECK_KEYS, where);
    let check: HttpCheck | TlsCheck;
    if (type === "tls") {
      check = parseTls(raw, where, id, name);
    } else {
      if (!nonEmptyString(raw.url)) {
        throw new ConfigError(`${where}.url is required and must be a non-empty string`);
      }
      const url = raw.url;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigError(`${where}.url is not a valid URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ConfigError(`${where}.url must be http or https`);
      }
      if (!positiveInt(raw.intervalMs)) {
        throw new ConfigError(`${where}.intervalMs must be a positive integer (milliseconds)`);
      }
      const retries = raw.retries ?? 0;
      if (!intIn(retries, 0, MAX_RETRIES)) {
        throw new ConfigError(`${where}.retries must be an integer from 0 to ${MAX_RETRIES}`);
      }
      const retryDelayMs = raw.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      if (!intIn(retryDelayMs, 0, MAX_RETRY_DELAY_MS)) {
        throw new ConfigError(
          `${where}.retryDelayMs must be an integer from 0 to ${MAX_RETRY_DELAY_MS} (milliseconds)`,
        );
      }
      if (raw.timeoutMs !== undefined && !positiveInt(raw.timeoutMs)) {
        throw new ConfigError(`${where}.timeoutMs must be a positive integer (milliseconds)`);
      }
      if (retries > 0) {
        const timeout = (raw.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
        const worst = (retries + 1) * timeout + retries * retryDelayMs;
        if (worst > raw.intervalMs) {
          throw new ConfigError(
            `${where}: worst case ${worst} ms ((retries + 1) * timeoutMs + retries * retryDelayMs) exceeds intervalMs ${raw.intervalMs}`,
          );
        }
      }
      if (raw.latencyObjectiveMs !== undefined && !positiveInt(raw.latencyObjectiveMs)) {
        throw new ConfigError(
          `${where}.latencyObjectiveMs must be a positive integer (milliseconds)`,
        );
      }
      check = { id, name, url, intervalMs: raw.intervalMs, retries, retryDelayMs };
      if (raw.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = raw.latencyObjectiveMs;
      if (raw.type === "http") check.type = "http";
    }
    if (raw.timeoutMs !== undefined && !positiveInt(raw.timeoutMs)) {
      throw new ConfigError(`${where}.timeoutMs must be a positive integer (milliseconds)`);
    }
    if (raw.keyword !== undefined) {
      if (check.type === "tls") {
        throw new ConfigError(`${where}.keyword is not allowed on a tls check`);
      }
      if (typeof raw.keyword !== "string" || raw.keyword === "") {
        throw new ConfigError(`${where}.keyword must be a non-empty string`);
      }
      check.keyword = raw.keyword;
    }
    if (seen.has(id)) throw new ConfigError(`duplicate check id "${id}"`);
    seen.add(id);
    if (raw.timeoutMs !== undefined) check.timeoutMs = raw.timeoutMs as number;
    checks.push(check);
  });
  return { checks, secrets };
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(v: unknown, where: string): number {
  if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v)) {
    throw new ConfigError(
      `${where} must be an ISO 8601 string with an explicit offset (Z or ±hh:mm)`,
    );
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new ConfigError(`${where} is not a valid date`);
  return ms;
}

export interface Config {
  checks: Check[];
  /** Ping secret per heartbeat check id. */
  secrets: Map<string, string>;
  maintenance: MaintenanceWindow[];
}

/** Validate a parsed config (checks plus optional maintenance windows); throws ConfigError. */
export function parseConfig(data: unknown): Config {
  const { checks, secrets } = parseChecksWithSecrets(data);
  const raw = (data as Record<string, unknown>).maintenance;
  if (raw === undefined) return { checks, secrets, maintenance: [] };
  if (!Array.isArray(raw)) throw new ConfigError('"maintenance" must be an array');
  const ids = new Set(checks.map((c) => c.id));
  const maintenance = raw.map((w: unknown, i: number): MaintenanceWindow => {
    const where = `maintenance[${i}]`;
    if (!isRecord(w)) throw new ConfigError(`${where} must be an object`);
    rejectUnknownKeys(w, MAINTENANCE_KEYS, where);
    if (!nonEmptyString(w.checkId) || !ids.has(w.checkId)) {
      throw new ConfigError(`${where}.checkId must reference a configured check`);
    }
    const start = parseInstant(w.start, `${where}.start`);
    const end = parseInstant(w.end, `${where}.end`);
    if (end <= start) throw new ConfigError(`${where}.end must be after start`);
    if (!nonEmptyString(w.note)) {
      throw new ConfigError(`${where}.note is required and must be a non-empty string`);
    }
    return { checkId: w.checkId, start, end, note: w.note };
  });
  return { checks, secrets, maintenance };
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read checks file ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`checks file ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Run a parser on the checks file; a validation error names the file: `<path>: <message>`. */
function parseFile<T>(path: string, parse: (data: unknown) => T): T {
  const data = readJson(path);
  try {
    return parse(data);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ConfigError(`${path}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

export function loadConfig(path: string): Config {
  return parseFile(path, parseConfig);
}

export function loadChecks(path: string): Check[] {
  return parseFile(path, parseChecks);
}

/** Read and validate the tokens file. Messages never contain a token value. */
export function loadTokens(path: string): ProbeToken[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new TokensError(`cannot read tokens file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // The JSON parser message can quote file content, so it is left out.
    throw new TokensError(`tokens file ${path} is not valid JSON`, { cause: err });
  }
  return parseTokens(data);
}
