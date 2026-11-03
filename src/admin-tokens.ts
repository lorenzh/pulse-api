import { z } from "zod";
import { firstIssue, type Issue, pathName } from "./issue-path.ts";
import { sha256Hex } from "./token-digest.ts";
import { TokensError, tokenSchema } from "./tokens.ts";

export type AdminToken = { name: string; token: string };

/** Admin-side secrets need more strength than probe tokens (MIN_TOKEN_LENGTH). */
export const ADMIN_MIN_TOKEN_LENGTH = 32;
const ADMIN_LENGTH_TEXT = `token must be a string of at least ${ADMIN_MIN_TOKEN_LENGTH} characters`;
// The length check runs first, so a short token gets the admin message; the shared rules follow.
const ADMIN_TOKEN_SCHEMA = z
  .string({ error: ADMIN_LENGTH_TEXT })
  // Zod's .min counts code points; the rule is JavaScript string length (UTF-16 code units).
  .refine((v) => v.length >= ADMIN_MIN_TOKEN_LENGTH, { error: ADMIN_LENGTH_TEXT, abort: true })
  .pipe(tokenSchema);

const SHAPE = 'admin tokens file must be an object with a "tokens" array';
const NAME_TEXT = "must be a non-empty string";

const ADMIN_SCHEMA = z.object(
  {
    tokens: z
      .array(
        z.object(
          {
            name: z.string({ error: NAME_TEXT }).refine((v) => v.trim() !== "", NAME_TEXT),
            token: ADMIN_TOKEN_SCHEMA,
          },
          { error: "must be an object" },
        ),
        { error: SHAPE },
      )
      .min(1, "admin tokens file needs at least one entry"),
  },
  { error: SHAPE },
);

function describe(issue: Issue): string {
  const where = pathName(issue.path);
  return where === "" ? issue.message : `${where} ${issue.message}`;
}

/** Validate the parsed admin tokens file; throws TokensError. Messages never contain a token. */
export function parseAdminTokens(data: unknown): AdminToken[] {
  const parsed = ADMIN_SCHEMA.safeParse(data);
  if (!parsed.success) {
    const issue = firstIssue(parsed.error.issues);
    throw new TokensError(issue === undefined ? SHAPE : describe(issue));
  }
  const seen = new Set<string>();
  return parsed.data.tokens.map((raw, index) => {
    if (seen.has(raw.token)) {
      throw new TokensError(`tokens[${index}] repeats an earlier admin token`);
    }
    seen.add(raw.token);
    return { name: raw.name.trim(), token: raw.token };
  });
}

/**
 * Refuse an admin token whose digest is already in use: a probe must never write incidents, and
 * one credential must never name two tokens. `probeDigests` are the stored and co-imported probe
 * credentials, `storedDigests` every stored credential. Messages never contain a token.
 */
export function assertDistinctDigests(
  admin: readonly AdminToken[],
  probeDigests: ReadonlySet<string>,
  storedDigests: ReadonlySet<string>,
): void {
  admin.forEach((entry, index) => {
    const hex = sha256Hex(entry.token);
    if (probeDigests.has(hex)) {
      throw new TokensError(`admin tokens[${index}] is also a probe token: use a separate token`);
    }
    if (storedDigests.has(hex)) {
      throw new TokensError(`admin tokens[${index}] repeats a stored token`);
    }
  });
}
