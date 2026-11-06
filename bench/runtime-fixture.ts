// Service tokens and the runtime configuration fixture of procedures 2 and 3 (spec of #570):
// token creation with the answer rules per side, the status settings document, five webhook
// channels, and the report check after the window. `fetch` is injected.
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RuntimeMode = "simulate" | "tokens";
export type RuntimeService = "status" | "notify";
export type Side = "a" | "b";
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const RUNTIME_SERVICES: readonly RuntimeService[] = ["status", "notify"];
/** The bench admin token; the api needs at least 32 characters (`src/admin-tokens.ts`). */
export const BENCH_ADMIN_TOKEN = "bench-admin-0123456789abcdef0123456789abcdef";
/** The env reference of the five bench webhooks; the notify container sets it. */
export const BENCH_NOTIFY_SECRET_ENV = "PULSE_NOTIFY_SECRET_BENCH";
export const BENCH_CHANNELS = 5;
/** Container path of the read-only service token mount. */
export const SERVICE_TOKENS_MOUNT = "/service-tokens";

export class HarnessError extends Error {
  override name = "HarnessError";
}

export type ServiceTokens = Record<RuntimeService, string>;

export interface RuntimeDeps {
  apiUrl: string;
  side: Side;
  fetch: Fetch;
  log: (line: string) => void;
}

/** The mode of the run; both options together are a usage error. */
export function runtimeMode(simulate: boolean, tokens: boolean): RuntimeMode | null {
  if (simulate && tokens) {
    throw new HarnessError("--simulate-services and --service-tokens exclude each other");
  }
  if (simulate) return "simulate";
  return tokens ? "tokens" : null;
}

const BASELINE_PREFIX = "token.scopes[0]: must be one of ";

/**
 * True only for the answer of an api without the new scopes: `400` with a JSON string `error` that
 * starts with the enum text of `scopes[0]` and does not list the requested scope in quotes.
 */
export function isBaselineRefusal(status: number, body: string, scope: RuntimeService): boolean {
  if (status !== 400) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: not the baseline answer, so the caller fails the run.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "error")) {
    return false;
  }
  const error = (parsed as { error: unknown }).error;
  return (
    typeof error === "string" && error.startsWith(BASELINE_PREFIX) && !error.includes(`"${scope}"`)
  );
}

function admin(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${BENCH_ADMIN_TOKEN}`, connection: "close", ...extra };
}

function secretOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "secret")) {
      return undefined;
    }
    const secret = (parsed as { secret: unknown }).secret;
    return typeof secret === "string" && secret !== "" ? secret : undefined;
  } catch {
    // A 201 without JSON is a harness error below.
    return undefined;
  }
}

/**
 * Creates the `status` and `notify` tokens. Returns null when side A of a simulation runs an api
 * without the new scopes; every other non-201 answer throws. B and the token mode never fall back.
 */
export async function createServiceTokens(
  deps: RuntimeDeps,
  mode: RuntimeMode,
): Promise<ServiceTokens | null> {
  const tokens: Partial<ServiceTokens> = {};
  let isAvailable = true;
  for (const scope of RUNTIME_SERVICES) {
    const response = await deps.fetch(`${deps.apiUrl}/admin/tokens`, {
      method: "POST",
      headers: admin({ "content-type": "application/json" }),
      body: JSON.stringify({ name: `bench ${scope}`, scopes: [scope] }),
    });
    const body = await response.text();
    const secret = response.status === 201 ? secretOf(body) : undefined;
    if (secret !== undefined) {
      tokens[scope] = secret;
    } else if (
      mode === "simulate" &&
      deps.side === "a" &&
      isBaselineRefusal(response.status, body, scope)
    ) {
      isAvailable = false;
    } else {
      throw new HarnessError(`service tokens: ${response.status} on ${deps.side}`);
    }
  }
  if (!isAvailable) {
    deps.log("service traffic: not available on a");
    return null;
  }
  const { status, notify } = tokens;
  if (status === undefined || notify === undefined) {
    throw new HarnessError(`service tokens: missing on ${deps.side}`);
  }
  return { status, notify };
}

async function etagOf(deps: RuntimeDeps, path: string): Promise<string> {
  const response = await deps.fetch(`${deps.apiUrl}${path}`, { headers: admin() });
  await response.arrayBuffer();
  const etag = response.headers.get("etag");
  if (response.status !== 200 || etag === null) {
    throw new HarnessError(`fixture: GET ${path} ${response.status} on ${deps.side}`);
  }
  return etag;
}

async function write(
  deps: RuntimeDeps,
  method: string,
  path: string,
  body: unknown,
  etag: string,
  expected: number,
): Promise<string> {
  const response = await deps.fetch(`${deps.apiUrl}${path}`, {
    method,
    headers: admin({ "content-type": "application/json", "if-match": etag }),
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  const next = response.headers.get("etag");
  if (response.status !== expected || next === null) {
    throw new HarnessError(`fixture: ${method} ${path} ${response.status} on ${deps.side}`);
  }
  return next;
}

/** One status settings document and five database webhooks; any other answer throws. */
export async function seedRuntimeFixture(deps: RuntimeDeps): Promise<void> {
  const settingsTag = await etagOf(deps, "/admin/status/settings");
  await write(
    deps,
    "PUT",
    "/admin/status/settings",
    { name: "Bench status", showLatency: false },
    settingsTag,
    200,
  );
  let channelsTag = await etagOf(deps, "/admin/notify/channels");
  for (let i = 0; i < BENCH_CHANNELS; i++) {
    const channel = { id: `bench-${i}`, type: "webhook", urlEnv: BENCH_NOTIFY_SECRET_ENV };
    channelsTag = await write(
      deps,
      "POST",
      "/admin/notify/channels",
      { ...channel, checks: ["c0"] },
      channelsTag,
      201,
    );
  }
}

export interface PreparedTokens {
  tokens: ServiceTokens | null;
  /** The compose variables; empty unless the token mode wrote the files. */
  env: { BENCH_STATUS_TOKEN_FILE: string; BENCH_NOTIFY_TOKEN_FILE: string };
}

const NO_TOKEN_ENV = { BENCH_STATUS_TOKEN_FILE: "", BENCH_NOTIFY_TOKEN_FILE: "" };

/**
 * The fixture step between the api start and the other services. Without a mode it does nothing.
 * The token mode writes `<dir>/status` and `<dir>/notify` with mode 0644, so the containers' `bun`
 * user reads them through the read-only mount.
 */
export async function prepareRuntime(
  deps: RuntimeDeps,
  mode: RuntimeMode | null,
  writeToken: (name: RuntimeService, secret: string) => Promise<void>,
): Promise<PreparedTokens> {
  if (mode === null) return { tokens: null, env: NO_TOKEN_ENV };
  const tokens = await createServiceTokens(deps, mode);
  if (tokens === null) return { tokens: null, env: NO_TOKEN_ENV };
  await seedRuntimeFixture(deps);
  if (mode === "simulate") return { tokens, env: NO_TOKEN_ENV };
  for (const name of RUNTIME_SERVICES) await writeToken(name, tokens[name]);
  return {
    tokens,
    env: {
      BENCH_STATUS_TOKEN_FILE: `${SERVICE_TOKENS_MOUNT}/status`,
      BENCH_NOTIFY_TOKEN_FILE: `${SERVICE_TOKENS_MOUNT}/notify`,
    },
  };
}

/** Mode 0644: the services run as the `bun` user and read it through a read-only mount. */
export async function writeTokenFile(
  dir: string,
  name: RuntimeService,
  secret: string,
): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, secret);
  await chmod(path, 0o644);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

const VIEW_PATH: Record<RuntimeService, string> = {
  status: "/admin/status/settings",
  notify: "/admin/notify/channels",
};

/**
 * The report check of procedure 3 after the window. On B the service must have reported fresh
 * and applied the current revision; on A the state is only logged.
 */
export async function checkReport(deps: RuntimeDeps, service: RuntimeService): Promise<void> {
  const response = await deps.fetch(`${deps.apiUrl}${VIEW_PATH[service]}`, { headers: admin() });
  const text = await response.text();
  let view: unknown;
  try {
    view = response.status === 200 ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: no report can be read, which B treats as not observed.
    view = undefined;
  }
  const part = field(view, "service");
  const state = field(part, "state");
  const applied = field(field(part, "report"), "appliedRevision");
  const revision = field(view, "revision");
  const isApplied = state === "fresh" && typeof revision === "string" && applied === revision;
  if (deps.side === "a") {
    deps.log(`${service} report on a: ${typeof state === "string" ? state : response.status}`);
    return;
  }
  if (!isApplied) throw new HarnessError(`${service} report not observed on b`);
  deps.log(`${service} report on b: fresh, applied ${revision}`);
}
