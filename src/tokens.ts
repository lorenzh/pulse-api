import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { firstIssue, type Issue, pathName } from "./issue-path.ts";
import { MAX_LOCATION_LENGTH } from "./service.ts";

export const MIN_TOKEN_LENGTH = 16;
const PLACEHOLDER_PREFIX = "replace-with-";

/** Tokens printed in the repository's examples. They are public, so they never authenticate. */
export const EXAMPLE_TOKENS: readonly string[] = [
  "example-token-change-me-0000",
  "example-token-0123456789abcdef",
];

export type ProbeToken = { location: string; token: string };

export class TokensError extends Error {
  override name = "TokensError";
}

const TOKEN_LENGTH_TEXT = `token must be a string of at least ${MIN_TOKEN_LENGTH} characters`;
const LOCATION_TEXT = "must be a non-empty string";
const TOKENS_SHAPE = 'tokens file must be an object with a "tokens" array';

// Unknown keys in an entry are ignored, as before. The token messages never contain a token.
const ENTRY_SCHEMA = z.object(
  {
    location: z
      .string({ error: LOCATION_TEXT })
      .refine((v) => v.trim() !== "", LOCATION_TEXT)
      .refine(
        (v) => v.trim().length <= MAX_LOCATION_LENGTH,
        `must be at most ${MAX_LOCATION_LENGTH} characters`,
      ),
    token: z
      .string({ error: TOKEN_LENGTH_TEXT })
      .min(MIN_TOKEN_LENGTH, TOKEN_LENGTH_TEXT)
      .refine((v) => !v.startsWith(PLACEHOLDER_PREFIX), "still has the example placeholder token")
      .refine((v) => !/\s/.test(v), "token must not contain whitespace")
      .refine((v) => !EXAMPLE_TOKENS.includes(v), "uses a public example token: generate your own"),
  },
  { error: "must be an object" },
);

const TOKENS_SCHEMA = z.object(
  {
    tokens: z
      .array(ENTRY_SCHEMA, { error: TOKENS_SHAPE })
      .min(1, "tokens file needs at least one entry"),
  },
  { error: TOKENS_SHAPE },
);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The trimmed location of entry `index` in the raw data, for a message about its token. */
function locationOf(data: unknown, index: number): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.tokens)) return undefined;
  const entry: unknown = data.tokens[index];
  if (!isRecord(entry) || typeof entry.location !== "string") return undefined;
  return entry.location.trim();
}

function describeIssue(issue: Issue, data: unknown): string {
  const [root, index, field] = issue.path;
  if (root !== "tokens") return issue.message;
  if (index === undefined) return issue.message;
  const where = pathName(["tokens", index]);
  if (field === undefined) return `${where} ${issue.message}`;
  if (field === "location") return `${where}.location ${issue.message}`;
  const location = typeof index === "number" ? locationOf(data, index) : undefined;
  return `${where} (location "${location ?? ""}") ${issue.message}`;
}

/** Validate the parsed tokens file; throws TokensError. Messages never contain a token. */
export function parseTokens(data: unknown): ProbeToken[] {
  const parsed = TOKENS_SCHEMA.safeParse(data);
  if (!parsed.success) {
    const issue = firstIssue(parsed.error.issues);
    throw new TokensError(issue === undefined ? TOKENS_SHAPE : describeIssue(issue, data));
  }
  const seen = new Map<string, number>();
  return parsed.data.tokens.map((raw, index) => {
    const first = seen.get(raw.token);
    if (first !== undefined) {
      throw new TokensError(`tokens[${index}] repeats the token of tokens[${first}]`);
    }
    seen.set(raw.token, index);
    return { location: raw.location.trim(), token: raw.token };
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
