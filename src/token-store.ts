import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  TOKEN_ID_PREFIX,
  TOKEN_ROTATION_OVERLAP_MS,
  TOKEN_SCOPES,
  TOKEN_SECRET_PREFIX,
  type TokenMetadata,
  type TokenScope,
} from "@lorenzh/pulse-contract";
import type { AuditRecord } from "./audit-log.ts";
import { sha256Hex } from "./token-digest.ts";
import { isLastActiveAdmin } from "./token-scopes.ts";

/** A persisted last-used value may lag the real one by at most this much (D4). */
export const LAST_USED_PERSIST_MS = 60_000;

/** `pulse_` and 32 random bytes in base64url without padding: 49 characters. */
export function generateSecret(): string {
  return TOKEN_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/** `tok_` and 24 lower-case hex characters. */
export function generateTokenId(): string {
  return TOKEN_ID_PREFIX + randomBytes(12).toString("hex");
}

/** Who made a change, as the audit entry stores it. */
export interface Actor {
  tokenId: string | null;
  name: string;
}

export interface NewToken {
  name: string;
  scopes: readonly TokenScope[];
  location: string | null;
  expiresAt: number | null;
  /** `file` tokens are imports: they keep their legacy secret and audit as `token.import`. */
  source: "api" | "file";
  /** Only for imports; an api token always gets a generated secret. */
  secret?: string;
}

/** The token behind a credential that authenticated. */
export interface AuthenticatedToken {
  id: string;
  name: string;
  scopes: TokenScope[];
  location: string | null;
}

export type AuthResult =
  | { kind: "ok"; token: AuthenticatedToken }
  | { kind: "unknown" }
  | { kind: "inactive" };

export type TokenStoreErrorReason = "not-found" | "revoked" | "expired" | "overlap" | "last-admin";

const REASON_TEXT: Record<TokenStoreErrorReason, string> = {
  "not-found": "token not found",
  revoked: "token is revoked",
  expired: "token is expired",
  overlap: "a rotation is still in its overlap",
  "last-admin": "cannot revoke the last active admin token",
};

/** An expected refusal of a rotate or revoke; the message is the response text of D6. */
export class TokenStoreError extends Error {
  override name = "TokenStoreError";
  readonly reason: TokenStoreErrorReason;
  constructor(reason: TokenStoreErrorReason) {
    super(REASON_TEXT[reason]);
    this.reason = reason;
  }
}

export interface TokenStoreDeps {
  db: Database;
  now: () => number;
  generateSecret: () => string;
  generateId: () => string;
  /** Records one audit entry inside the token write's transaction; a throw rolls it back. */
  recordAudit: (entry: AuditRecord) => void;
}

export interface TokenStore {
  create(input: NewToken, actor: Actor): { token: TokenMetadata; secret: string };
  rotate(id: string, actor: Actor): { token: TokenMetadata; secret: string };
  revoke(id: string, actor: Actor): TokenMetadata;
  authenticate(secret: string): AuthResult;
  get(id: string): TokenMetadata | null;
  /** All tokens, revoked ones included, by `createdAt` and then `id`. */
  list(): TokenMetadata[];
  /** Persist every in-memory last-used value that is not on disk yet. Call before `db.close`. */
  flush(): void;
}

interface TokenRow {
  id: string;
  name: string;
  scopes_json: string;
  location: string | null;
  source: "api" | "file";
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  rotated_at: number | null;
}

interface SecretRow {
  secret_sha256: string;
  token_id: string;
  retires_at: number | null;
}

/** In-memory state of a non-revoked token. */
interface TokenState extends AuthenticatedToken {
  expiresAt: number | null;
  lastUsedAt: number | null;
  persistedLastUsedAt: number | null;
}

interface Credential {
  digest: Buffer;
  tokenId: string;
  retiresAt: number | null;
}

const TOKEN_COLUMNS =
  "id, name, scopes_json, location, source, created_at, last_used_at, expires_at, revoked_at, rotated_at";

function ordered(scopes: readonly TokenScope[]): TokenScope[] {
  return TOKEN_SCOPES.filter((s) => scopes.includes(s));
}

// scopes_json is written only by this module, from validated scopes.
const scopesOf = (row: TokenRow): TokenScope[] =>
  ordered(JSON.parse(row.scopes_json) as TokenScope[]);

function stateOf(row: TokenRow): TokenState {
  return {
    id: row.id,
    name: row.name,
    scopes: scopesOf(row),
    location: row.location,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    persistedLastUsedAt: row.last_used_at,
  };
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const { db, now } = deps;
  const tokens = new Map<string, TokenState>();
  const credentials = new Map<string, Credential>();

  const addCredential = (hex: string, tokenId: string, retiresAt: number | null): void => {
    credentials.set(hex, { digest: Buffer.from(hex, "hex"), tokenId, retiresAt });
  };

  for (const row of db
    .query(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE revoked_at IS NULL`)
    .all() as TokenRow[]) {
    tokens.set(row.id, stateOf(row));
  }
  const loadedAt = now();
  for (const row of db
    .query("SELECT secret_sha256, token_id, retires_at FROM token_secrets")
    .all() as SecretRow[]) {
    const isRetired = row.retires_at !== null && row.retires_at <= loadedAt;
    if (tokens.has(row.token_id) && !isRetired) {
      addCredential(row.secret_sha256, row.token_id, row.retires_at);
    }
  }

  const readRow = (id: string): TokenRow | null =>
    db.query(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE id = ?`).get(id) as TokenRow | null;

  const previousValidUntil = (id: string, at: number): number | null => {
    const row = db
      .query(
        "SELECT MAX(retires_at) AS until FROM token_secrets WHERE token_id = ? AND retires_at > ?",
      )
      .get(id, at) as { until: number | null } | null;
    return row?.until ?? null;
  };

  const metadataOf = (row: TokenRow): TokenMetadata => ({
    id: row.id,
    name: row.name,
    scopes: scopesOf(row),
    location: row.location,
    source: row.source,
    createdAt: row.created_at,
    lastUsedAt: tokens.get(row.id)?.lastUsedAt ?? row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    rotatedAt: row.rotated_at,
    previousValidUntil: previousValidUntil(row.id, now()),
  });

  const mustRead = (id: string): TokenRow => {
    const row = readRow(id);
    if (row === null) throw new TokenStoreError("not-found");
    return row;
  };

  const audit = (at: number, actor: Actor, action: AuditRecord["action"], id: string): void => {
    deps.recordAudit({ at, actor, action, target: { kind: "token", id }, revision: null });
  };

  const insertSecret = (hex: string, id: string, at: number): void => {
    db.query(
      "INSERT INTO token_secrets (secret_sha256, token_id, created_at, retires_at) VALUES (?, ?, ?, NULL)",
    ).run(hex, id, at);
  };

  const activity = (row: TokenRow) => ({
    id: row.id,
    scopes: scopesOf(row),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  });

  const persistLastUsed = (state: TokenState, value: number): void => {
    db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(value, state.id);
    state.persistedLastUsedAt = value;
  };

  const flushOne = (state: TokenState): void => {
    if (state.lastUsedAt !== null && state.lastUsedAt !== state.persistedLastUsedAt) {
      persistLastUsed(state, state.lastUsedAt);
    }
  };

  return {
    create(input, actor) {
      const at = now();
      const id = deps.generateId();
      const secret = input.secret ?? deps.generateSecret();
      const hex = sha256Hex(secret);
      const scopes = ordered(input.scopes);
      db.transaction(() => {
        db.query(
          `INSERT INTO api_tokens (${TOKEN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
        ).run(
          id,
          input.name,
          JSON.stringify(scopes),
          input.location,
          input.source,
          at,
          input.expiresAt,
        );
        insertSecret(hex, id, at);
        audit(at, actor, input.source === "file" ? "token.import" : "token.create", id);
      })();
      const row = mustRead(id);
      tokens.set(id, stateOf(row));
      addCredential(hex, id, null);
      return { token: metadataOf(row), secret };
    },

    rotate(id, actor) {
      const at = now();
      const secret = deps.generateSecret();
      const hex = sha256Hex(secret);
      const retiresAt = at + TOKEN_ROTATION_OVERLAP_MS;
      const dropped = db.transaction(() => {
        const row = mustRead(id);
        if (row.revoked_at !== null) throw new TokenStoreError("revoked");
        if (row.expires_at !== null && at >= row.expires_at) throw new TokenStoreError("expired");
        if (previousValidUntil(id, at) !== null) throw new TokenStoreError("overlap");
        const old = db
          .query(
            "DELETE FROM token_secrets WHERE token_id = ? AND retires_at IS NOT NULL AND retires_at <= ? RETURNING secret_sha256",
          )
          .all(id, at) as { secret_sha256: string }[];
        const current = db
          .query(
            "UPDATE token_secrets SET retires_at = ? WHERE token_id = ? AND retires_at IS NULL RETURNING secret_sha256",
          )
          .all(retiresAt, id) as { secret_sha256: string }[];
        insertSecret(hex, id, at);
        db.query("UPDATE api_tokens SET rotated_at = ? WHERE id = ?").run(at, id);
        audit(at, actor, "token.rotate", id);
        return { old, current };
      })();
      for (const { secret_sha256 } of dropped.old) credentials.delete(secret_sha256);
      for (const { secret_sha256 } of dropped.current) addCredential(secret_sha256, id, retiresAt);
      addCredential(hex, id, null);
      return { token: metadataOf(mustRead(id)), secret };
    },

    revoke(id, actor) {
      const at = now();
      const state = tokens.get(id);
      db.transaction(() => {
        const row = mustRead(id);
        if (row.revoked_at !== null) throw new TokenStoreError("revoked");
        const others = (
          db.query(`SELECT ${TOKEN_COLUMNS} FROM api_tokens`).all() as TokenRow[]
        ).map(activity);
        if (isLastActiveAdmin(activity(row), others, at)) throw new TokenStoreError("last-admin");
        // The token leaves the index, so its last-used value commits with the revocation:
        // a failed write then leaves the token unrevoked instead of revoked but usable.
        const lastUsed = state?.lastUsedAt ?? null;
        db.query(
          "UPDATE api_tokens SET revoked_at = ?, last_used_at = COALESCE(?, last_used_at) WHERE id = ?",
        ).run(at, lastUsed, id);
        audit(at, actor, "token.revoke", id);
      })();
      tokens.delete(id);
      for (const [hex, credential] of credentials) {
        if (credential.tokenId === id) credentials.delete(hex);
      }
      return metadataOf(mustRead(id));
    },

    authenticate(secret) {
      const hex = sha256Hex(secret);
      const credential = credentials.get(hex);
      if (credential === undefined) return { kind: "unknown" };
      if (!timingSafeEqual(credential.digest, Buffer.from(hex, "hex"))) return { kind: "unknown" };
      const state = tokens.get(credential.tokenId);
      if (state === undefined) return { kind: "unknown" };
      const at = now();
      const isRetired = credential.retiresAt !== null && at >= credential.retiresAt;
      const isExpired = state.expiresAt !== null && at >= state.expiresAt;
      if (isRetired || isExpired) return { kind: "inactive" };
      state.lastUsedAt = at;
      const persisted = state.persistedLastUsedAt;
      if (persisted === null || at - persisted >= LAST_USED_PERSIST_MS) persistLastUsed(state, at);
      const { id, name, scopes, location } = state;
      return { kind: "ok", token: { id, name, scopes, location } };
    },

    get(id) {
      const row = readRow(id);
      return row === null ? null : metadataOf(row);
    },

    list() {
      const rows = db
        .query(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at ASC, id ASC`)
        .all() as TokenRow[];
      return rows.map(metadataOf);
    },

    flush() {
      for (const state of tokens.values()) flushOne(state);
    },
  };
}
