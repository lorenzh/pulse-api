import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_LOCATION_LENGTH } from "./service.ts";

export const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_PREFIX = "replace-with-";

export type ProbeToken = { location: string; token: string };

export class TokensError extends Error {
  override name = "TokensError";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEntry(raw: unknown, index: number): ProbeToken {
  const where = `tokens[${index}]`;
  if (!isRecord(raw)) throw new TokensError(`${where} must be an object`);
  if (typeof raw.location !== "string" || raw.location.trim() === "") {
    throw new TokensError(`${where}.location must be a non-empty string`);
  }
  const location = raw.location.trim();
  if (location.length > MAX_LOCATION_LENGTH) {
    throw new TokensError(`${where}.location must be at most ${MAX_LOCATION_LENGTH} characters`);
  }
  if (typeof raw.token !== "string" || raw.token.length < MIN_TOKEN_LENGTH) {
    throw new TokensError(
      `${where} (location "${location}") token must be a string of at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  if (raw.token.startsWith(PLACEHOLDER_PREFIX)) {
    throw new TokensError(
      `${where} (location "${location}") still has the example placeholder token`,
    );
  }
  return { location, token: raw.token };
}

/** Validate the parsed tokens file; throws TokensError. Messages never contain a token. */
export function parseTokens(data: unknown): ProbeToken[] {
  if (!isRecord(data) || !Array.isArray(data.tokens)) {
    throw new TokensError('tokens file must be an object with a "tokens" array');
  }
  if (data.tokens.length === 0) throw new TokensError("tokens file needs at least one entry");
  const seen = new Map<string, number>();
  return data.tokens.map((raw: unknown, index: number) => {
    const entry = parseEntry(raw, index);
    const first = seen.get(entry.token);
    if (first !== undefined) {
      throw new TokensError(`tokens[${index}] repeats the token of tokens[${first}]`);
    }
    seen.set(entry.token, index);
    return entry;
  });
}

const BEARER = /^bearer (\S+)$/i;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Return the location bound to the bearer token in `header`, or undefined. */
export function authenticate(
  tokens: readonly ProbeToken[],
  header: string | undefined,
): string | undefined {
  const presented = header === undefined ? undefined : BEARER.exec(header)?.[1];
  if (presented === undefined) return undefined;
  const wanted = digest(presented);
  let location: string | undefined;
  // No early exit: every configured token is compared.
  for (const entry of tokens) {
    if (timingSafeEqual(wanted, digest(entry.token)) && location === undefined) {
      location = entry.location;
    }
  }
  return location;
}
