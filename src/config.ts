import { readFileSync } from "node:fs";
import {
  type Check,
  type Component,
  type HttpCheck,
  MAX_TIMER_MS,
  type MaintenanceWindow,
  type TlsCheck,
  validateCheck,
  validateComponent,
} from "@lorenzh/pulse-contract";
import { z } from "zod";
import { type AdminToken, parseAdminTokens } from "./admin-tokens.ts";
import { firstIssue, type Issue, pathName, unknownKey } from "./issue-path.ts";
import { type ProbeToken, parseTokens, TokensError } from "./tokens.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TIMER_RANGE = `an integer from 1 to ${MAX_TIMER_MS} (milliseconds)`;

const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TLS_PORT = 443;
const DEFAULT_WARN_DAYS = 14;
const MIN_HEARTBEAT_PERIOD_MS = 1000;
const MAX_HEARTBEAT_MS = 86_400_000;
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 128;
const SECRET_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** A whole number from min to max; every failure reads `message`. */
function intIn(min: number, max: number, message: string): z.ZodNumber {
  return z.number({ error: message }).int(message).min(min, message).max(max, message);
}

/** An integer from 1 to MAX_TIMER_MS: the largest delay a timer takes. */
function timerMs(): z.ZodNumber {
  return intIn(1, MAX_TIMER_MS, `must be ${TIMER_RANGE}`);
}

const REQUIRED_TEXT = "is required and must be a non-empty string";

function requiredText(message: string = REQUIRED_TEXT): z.ZodString {
  return z.string({ error: message }).refine((v) => v.trim() !== "", message);
}

function isHostName(host: string): boolean {
  return !(
    host.trim() === "" ||
    host !== host.trim() ||
    /[\s/\\?#@]/.test(host) ||
    host.includes("://") ||
    // a colon is only valid in a bracketless IPv6 literal, which has at least two
    (host.includes(":") && host.split(":").length < 3)
  );
}

function protocolOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    // not a URL: the caller reports it
    return undefined;
  }
}

const URL_TEXT = z
  .string({ error: REQUIRED_TEXT })
  .refine((v) => v.trim() !== "", REQUIRED_TEXT)
  .refine((v) => protocolOf(v) !== undefined, "is not a valid URL")
  .refine((v) => {
    const protocol = protocolOf(v);
    return protocol === "http:" || protocol === "https:";
  }, "must be http or https");

const KEYWORD = z
  .string({ error: "must be a non-empty string" })
  .min(1, "must be a non-empty string")
  .optional();

const ID_NAME = { id: requiredText(), name: requiredText() };

const HTTP_SCHEMA = z.strictObject({
  ...ID_NAME,
  type: z.literal("http").optional(),
  url: URL_TEXT,
  intervalMs: timerMs(),
  retries: intIn(0, MAX_RETRIES, `must be an integer from 0 to ${MAX_RETRIES}`).default(0),
  retryDelayMs: intIn(
    0,
    MAX_RETRY_DELAY_MS,
    `must be an integer from 0 to ${MAX_RETRY_DELAY_MS} (milliseconds)`,
  ).default(DEFAULT_RETRY_DELAY_MS),
  timeoutMs: timerMs().optional(),
  latencyObjectiveMs: timerMs().optional(),
  keyword: KEYWORD,
  // The contract validates these; see parseHttp.
  method: z.unknown().optional(),
  headers: z.unknown().optional(),
  body: z.unknown().optional(),
  expectedStatus: z.unknown().optional(),
  jsonAssert: z.unknown().optional(),
});

const TLS_HOST = "must be a host name without scheme, port or path";
const TLS_SCHEMA = z.strictObject({
  ...ID_NAME,
  type: z.literal("tls"),
  host: z.string({ error: TLS_HOST }).refine(isHostName, TLS_HOST),
  port: intIn(1, 65535, "must be an integer from 1 to 65535").default(DEFAULT_TLS_PORT),
  warnDays: z
    .number({ error: "must be an integer of 0 or more (days)" })
    .int("must be an integer of 0 or more (days)")
    .min(0, "must be an integer of 0 or more (days)")
    .default(DEFAULT_WARN_DAYS),
  intervalMs: timerMs(),
  timeoutMs: timerMs().optional(),
  keyword: z.never({ error: "is not allowed on a tls check" }).optional(),
  method: z.never({ error: "is not allowed on a tls check" }).optional(),
  headers: z.never({ error: "is not allowed on a tls check" }).optional(),
  body: z.never({ error: "is not allowed on a tls check" }).optional(),
  expectedStatus: z.never({ error: "is not allowed on a tls check" }).optional(),
  jsonAssert: z.never({ error: "is not allowed on a tls check" }).optional(),
});

const SECRET_TEXT = `is required: ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters from A-Z a-z 0-9 . _ ~ -`;
const HEARTBEAT_SCHEMA = z.strictObject({
  ...ID_NAME,
  type: z.literal("heartbeat"),
  period: intIn(
    MIN_HEARTBEAT_PERIOD_MS,
    MAX_HEARTBEAT_MS,
    `must be an integer from ${MIN_HEARTBEAT_PERIOD_MS} to ${MAX_HEARTBEAT_MS} (milliseconds)`,
  ),
  grace: intIn(
    0,
    MAX_HEARTBEAT_MS,
    `must be an integer from 0 to ${MAX_HEARTBEAT_MS} (milliseconds)`,
  ).default(0),
  // The message never contains the secret value.
  secret: z
    .string({ error: SECRET_TEXT })
    .min(MIN_SECRET_LENGTH, SECRET_TEXT)
    .max(MAX_SECRET_LENGTH, SECRET_TEXT)
    .regex(SECRET_PATTERN, SECRET_TEXT),
});

/** `unknown key "x" in checks[2]` or `checks[1].port must be ...`; never reads the input. */
function describeIssue(issue: Issue, prefix: readonly PropertyKey[]): string {
  const path = [...prefix, ...issue.path];
  const key = unknownKey(issue);
  if (key !== undefined) {
    return `unknown key "${key}" in ${path.length === 0 ? "the top level" : pathName(path)}`;
  }
  return `${pathName(path)} ${issue.message}`;
}

function failWith(error: z.ZodError, prefix: readonly PropertyKey[]): never {
  const issue = firstIssue(error.issues);
  if (issue === undefined) throw new ConfigError("invalid config");
  throw new ConfigError(describeIssue(issue, prefix));
}

function parseHttp(raw: Record<string, unknown>, where: (string | number)[]): HttpCheck {
  const parsed = HTTP_SCHEMA.safeParse(raw);
  if (!parsed.success) return failWith(parsed.error, where);
  const v = parsed.data;
  const timeout = v.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worst = (v.retries + 1) * timeout + v.retries * v.retryDelayMs;
  if (v.retries > 0 && worst > v.intervalMs) {
    throw new ConfigError(
      `${pathName(where)}: worst case ${worst} ms ((retries + 1) * timeoutMs + retries * retryDelayMs) exceeds intervalMs ${v.intervalMs}`,
    );
  }
  const check: HttpCheck = {
    id: v.id,
    name: v.name,
    url: v.url,
    intervalMs: v.intervalMs,
    retries: v.retries,
    retryDelayMs: v.retryDelayMs,
  };
  if (v.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = v.latencyObjectiveMs;
  if (v.type === "http") check.type = "http";
  if (v.keyword !== undefined) check.keyword = v.keyword;
  if (v.timeoutMs !== undefined) check.timeoutMs = v.timeoutMs;
  const request = { method: v.method, headers: v.headers, body: v.body };
  const rules = { expectedStatus: v.expectedStatus, jsonAssert: v.jsonAssert };
  const candidate = { ...check, ...request, ...rules };
  // The contract owns the limits. Its messages name the field path and never quote a value.
  const verdict = validateCheck(candidate, pathName(where));
  if (!verdict.ok) throw new ConfigError(verdict.error);
  return verdict.value.type === "tls" || verdict.value.type === "heartbeat"
    ? check
    : withoutUndefined(verdict.value);
}

/** The contract validators accept explicit `undefined`; the stored check has no such keys. */
function withoutUndefined(check: HttpCheck): HttpCheck {
  const out: HttpCheck = { ...check };
  for (const key of ["method", "headers", "body", "expectedStatus", "jsonAssert"] as const) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function parseTls(raw: Record<string, unknown>, where: (string | number)[]): TlsCheck {
  const parsed = TLS_SCHEMA.safeParse(raw);
  if (!parsed.success) return failWith(parsed.error, where);
  const { id, name, host, port, warnDays, intervalMs, timeoutMs } = parsed.data;
  const check: TlsCheck = { id, name, type: "tls", host, port, warnDays, intervalMs };
  if (timeoutMs !== undefined) check.timeoutMs = timeoutMs;
  return check;
}

function parseHeartbeat(
  raw: Record<string, unknown>,
  where: (string | number)[],
): { check: Check; secret: string } {
  const parsed = HEARTBEAT_SCHEMA.safeParse(raw);
  if (!parsed.success) return failWith(parsed.error, where);
  const { id, name, period, grace, secret } = parsed.data;
  return { check: { id, name, type: "heartbeat", period, grace }, secret };
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

const TOP_SCHEMA = z.strictObject(
  {
    checks: z.array(z.unknown(), { error: 'config must be an object with a "checks" array' }),
    // Checked after the checks: it needs their ids.
    maintenance: z.unknown().optional(),
    components: z.unknown().optional(),
  },
  { error: 'config must be an object with a "checks" array' },
);

/** Validate a parsed checks file and return the heartbeat secrets with it; throws ConfigError. */
export function parseChecksWithSecrets(data: unknown): ParsedChecks {
  const top = TOP_SCHEMA.safeParse(data);
  if (!top.success) {
    const issue = firstIssue(top.error.issues);
    if (issue !== undefined && unknownKey(issue) !== undefined) return failWith(top.error, []);
    throw new ConfigError('config must be an object with a "checks" array');
  }
  const seen = new Set<string>();
  const checks: Check[] = [];
  const secrets = new Map<string, string>();
  top.data.checks.forEach((raw: unknown, i: number) => {
    const where = ["checks", i];
    if (!isRecord(raw)) throw new ConfigError(`${pathName(where)} must be an object`);
    const type = raw.type ?? "http";
    if (type !== "http" && type !== "tls" && type !== "heartbeat") {
      throw new ConfigError(`${pathName(where)}.type must be "http", "tls" or "heartbeat"`);
    }
    let check: Check;
    if (type === "heartbeat") {
      const parsed = parseHeartbeat(raw, where);
      check = parsed.check;
      secrets.set(check.id, parsed.secret);
    } else {
      check = type === "tls" ? parseTls(raw, where) : parseHttp(raw, where);
    }
    if (seen.has(check.id)) throw new ConfigError(`duplicate check id "${check.id}"`);
    seen.add(check.id);
    checks.push(check);
  });
  return { checks, secrets };
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Date.parse rolls 02-30 over to 03-02; check the components against the real calendar. */
function isRealCalendarTime(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Not Date.UTC: it maps years 0-99 to 1900-1999.
  const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const februaryDays = isLeap ? 29 : 28;
  const daysInMonth = month === 2 ? februaryDays : 30 + ((month + Math.floor(month / 8)) % 2);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

const ISO_TEXT = "must be an ISO 8601 string with an explicit offset (Z or ±hh:mm)";

const INSTANT = z
  .string({ error: ISO_TEXT })
  .regex(ISO_WITH_OFFSET, ISO_TEXT)
  .refine((v) => !Number.isNaN(Date.parse(v)) && isRealCalendarTime(v), "is not a valid date")
  .transform((v) => Date.parse(v));

export interface Config {
  checks: Check[];
  /** Ping secret per heartbeat check id. */
  secrets: Map<string, string>;
  maintenance: MaintenanceWindow[];
  /** Customer-facing groups of checks, in configured order. Read only by the component routes. */
  components: Component[];
}

function maintenanceSchema(ids: ReadonlySet<string>): z.ZodArray<z.ZodType<MaintenanceWindow>> {
  const window = z.strictObject(
    {
      checkId: requiredText("must reference a configured check").refine(
        (v) => ids.has(v),
        "must reference a configured check",
      ),
      start: INSTANT,
      end: INSTANT,
      note: requiredText(),
    },
    { error: "must be an object" },
  );
  return z.array(window);
}

function parseMaintenance(raw: unknown, ids: ReadonlySet<string>): MaintenanceWindow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError('"maintenance" must be an array');
  const parsed = maintenanceSchema(ids).safeParse(raw);
  if (!parsed.success) return failWith(parsed.error, ["maintenance"]);
  const maintenance = parsed.data;
  maintenance.forEach((w, i) => {
    if (w.end <= w.start) throw new ConfigError(`maintenance[${i}].end must be after start`);
  });
  return maintenance;
}

/** Components are validated by the contract; the check ids and the component ids need the file. */
function parseComponents(raw: unknown, ids: ReadonlySet<string>): Component[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError('"components" must be an array');
  const seen = new Set<string>();
  return raw.map((item: unknown, i: number): Component => {
    const where = `components[${i}]`;
    const verdict = validateComponent(item, where);
    if (!verdict.ok) throw new ConfigError(verdict.error);
    const component = verdict.value;
    if (seen.has(component.id))
      throw new ConfigError(`${where}.id: duplicate component id "${component.id}"`);
    seen.add(component.id);
    component.checkIds.forEach((checkId, j) => {
      if (!ids.has(checkId)) {
        throw new ConfigError(`${where}.checkIds[${j}] must reference a configured check`);
      }
    });
    return component;
  });
}

/** Validate a parsed config (checks plus optional maintenance windows and components); throws ConfigError. */
export function parseConfig(data: unknown): Config {
  const { checks, secrets } = parseChecksWithSecrets(data);
  const top = data as Record<string, unknown>;
  const ids = new Set(checks.map((c) => c.id));
  const maintenance = parseMaintenance(top.maintenance, ids);
  const components = parseComponents(top.components, ids);
  return { checks, secrets, maintenance, components };
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
    // The JSON parser message can quote file content (a header value or a body), so it is left out.
    throw new ConfigError(`checks file ${path} is not valid JSON`, { cause: err });
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

function readTokensJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new TokensError(`cannot read ${label} ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // The JSON parser message can quote file content, so it is left out.
    throw new TokensError(`${label} ${path} is not valid JSON`, { cause: err });
  }
}

/** Read and validate the tokens file. Messages never contain a token value. */
export function loadTokens(path: string): ProbeToken[] {
  return parseTokens(readTokensJson(path, "tokens file"));
}

/** Read and validate the admin tokens file. Messages never contain a token value. */
export function loadAdminTokens(path: string): AdminToken[] {
  return parseAdminTokens(readTokensJson(path, "admin tokens file"));
}
