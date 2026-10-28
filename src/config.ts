import { readFileSync } from "node:fs";
import type { Check } from "@lorenzh/pulse-contract";

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

export function loadChecks(path: string): Check[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read checks file ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`checks file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseChecks(data);
}
