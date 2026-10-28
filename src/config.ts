import { readFileSync } from "node:fs";
import type { Check, MaintenanceWindow } from "@lorenzh/pulse-contract";

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

/** Validate a parsed checks file; throws ConfigError. */
export function parseChecks(data: unknown): Check[] {
  if (!isRecord(data) || !Array.isArray(data.checks)) {
    throw new ConfigError('config must be an object with a "checks" array');
  }
  const seen = new Set<string>();
  const checks: Check[] = [];
  data.checks.forEach((raw: unknown, i: number) => {
    const where = `checks[${i}]`;
    if (!isRecord(raw)) throw new ConfigError(`${where} must be an object`);
    for (const field of ["id", "name", "url"]) {
      if (!nonEmptyString(raw[field])) {
        throw new ConfigError(`${where}.${field} is required and must be a non-empty string`);
      }
    }
    const { id, name, url } = raw as { id: string; name: string; url: string };
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
    if (raw.timeoutMs !== undefined && !positiveInt(raw.timeoutMs)) {
      throw new ConfigError(`${where}.timeoutMs must be a positive integer (milliseconds)`);
    }
    if (seen.has(id)) throw new ConfigError(`duplicate check id "${id}"`);
    seen.add(id);
    const check: Check = { id, name, url, intervalMs: raw.intervalMs };
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
