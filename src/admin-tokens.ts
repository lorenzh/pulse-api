import { z } from "zod";
import { firstIssue, type Issue, pathName } from "./issue-path.ts";
import { type ProbeToken, TokensError, tokenSchema } from "./tokens.ts";

export type AdminToken = { name: string; token: string };

const SHAPE = 'admin tokens file must be an object with a "tokens" array';
const NAME_TEXT = "must be a non-empty string";

const ADMIN_SCHEMA = z.object(
  {
    tokens: z
      .array(
        z.object(
          {
            name: z.string({ error: NAME_TEXT }).refine((v) => v.trim() !== "", NAME_TEXT),
            token: tokenSchema,
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

/** Refuse an admin token that is also a probe token: a probe must never write incidents. */
export function assertDistinctFromProbeTokens(
  admin: readonly AdminToken[],
  probe: readonly ProbeToken[],
): void {
  const probeTokens = new Set(probe.map((p) => p.token));
  const index = admin.findIndex((a) => probeTokens.has(a.token));
  if (index >= 0) {
    throw new TokensError(`admin tokens[${index}] is also a probe token: use a separate token`);
  }
}
