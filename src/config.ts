import { readFileSync } from "node:fs";
import type { Check, MaintenanceWindow } from "@lorenzh/pulse-contract";
import { type ProbeToken, parseTokens, TokensError } from "./tokens.ts";

export class ConfigError extends Error {}

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

const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TLS_PORT = 443;
const DEFAULT_WARN_DAYS = 14;

function parseTls(raw: Record<string, unknown>, where: string, id: string, name: string): Check {
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

/** Validate a parsed checks file; throws ConfigError. */
export function parseChecks(data: unknown): Check[] {
  if (!isRecord(data) || !Array.isArray(data.checks)) {
    throw new ConfigError('config must be an object with a "checks" array');
  }
  const seen = new Set<string>();
  const checks: Check[] = [];
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
    if (type !== "http" && type !== "tls") {
      throw new ConfigError(`${where}.type must be "http" or "tls"`);
    }
    let check: Check;
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
  return checks;
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
  maintenance: MaintenanceWindow[];
}

/** Validate a parsed config (checks plus optional maintenance windows); throws ConfigError. */
export function parseConfig(data: unknown): Config {
  const checks = parseChecks(data);
  const raw = (data as Record<string, unknown>).maintenance;
  if (raw === undefined) return { checks, maintenance: [] };
  if (!Array.isArray(raw)) throw new ConfigError('"maintenance" must be an array');
  const ids = new Set(checks.map((c) => c.id));
  const maintenance = raw.map((w: unknown, i: number): MaintenanceWindow => {
    const where = `maintenance[${i}]`;
    if (!isRecord(w)) throw new ConfigError(`${where} must be an object`);
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
  return { checks, maintenance };
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

export function loadConfig(path: string): Config {
  return parseConfig(readJson(path));
}

export function loadChecks(path: string): Check[] {
  return parseChecks(readJson(path));
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
