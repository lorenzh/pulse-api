import type { z } from "zod";

export type Issue = z.core.$ZodIssue;

/** A path as a config reader writes it: `checks[1].port`, `tokens[0]`. */
export function pathName(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}

/** The first unknown key of an `unrecognized_keys` issue, or undefined for any other issue. */
export function unknownKey(issue: Issue): string | undefined {
  return issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
}

/**
 * Pick the issue to report. An unknown key comes before the field errors
 * of the same object, as the hand-written checks did. The issue's input is never read,
 * so a message cannot echo a secret.
 */
export function firstIssue(issues: readonly Issue[]): Issue | undefined {
  return issues.find((i) => i.code === "unrecognized_keys") ?? issues[0];
}
