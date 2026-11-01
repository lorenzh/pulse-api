import { createHash } from "node:crypto";

/** Lower-case hex SHA-256 of the UTF-8 bytes of `value`: the stored form of a credential. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
