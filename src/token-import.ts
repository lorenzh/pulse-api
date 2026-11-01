import type { Database } from "bun:sqlite";
import { type AdminToken, assertDistinctDigests } from "./admin-tokens.ts";
import { createAuditLog } from "./audit-log.ts";
import { sha256Hex } from "./token-digest.ts";
import {
  type Actor,
  createTokenStore,
  generateSecret,
  generateTokenId,
  type TokenStore,
} from "./token-store.ts";
import type { ProbeToken } from "./tokens.ts";

/** Which one-time imports already ran (a `token_bootstrap` row each). */
export interface Bootstrap {
  isProbeDone: boolean;
  isAdminDone: boolean;
}

/** The parsed files of the pending imports; undefined means that import does not run now. */
export interface PendingImports {
  probe: readonly ProbeToken[] | undefined;
  admin: readonly AdminToken[] | undefined;
}

export interface ImportDeps {
  db: Database;
  now: () => number;
  /** Defaults to `generateTokenId`. */
  generateId?: () => string;
  /** Secrets of tokens the store creates later; defaults to `generateSecret`. */
  generateSecret?: () => string;
}

/** Legacy admin tokens keep today's access: config read and writes, incident writes, admin. */
const ADMIN_SCOPES = ["read", "checks", "incidents", "admin"] as const;

const BOOTSTRAP_ACTOR: Actor = { tokenId: null, name: "bootstrap" };

/** The stored bootstrap rows. */
export function readBootstrap(db: Database): Bootstrap {
  const kinds = new Set(
    (db.query("SELECT kind FROM token_bootstrap").all() as { kind: string }[]).map((r) => r.kind),
  );
  return { isProbeDone: kinds.has("probe"), isAdminDone: kinds.has("admin") };
}

function storedDigests(db: Database): { probe: Set<string>; all: Set<string> } {
  const rows = db
    .query(
      "SELECT s.secret_sha256 AS hex, t.scopes_json AS scopes FROM token_secrets s JOIN api_tokens t ON t.id = s.token_id",
    )
    .all() as { hex: string; scopes: string }[];
  const probe = new Set<string>();
  const all = new Set<string>();
  for (const row of rows) {
    all.add(row.hex);
    // scopes_json is written only by the token store, as a JSON array of scope names.
    if ((JSON.parse(row.scopes) as string[]).includes("probe")) probe.add(row.hex);
  }
  return { probe, all };
}

/**
 * Run the pending imports in one transaction (D5): every token, its `token.import` entry and the
 * bootstrap rows commit together, or nothing does. Throws TokensError for a duplicate admin digest.
 */
function importTokens(deps: ImportDeps, pending: PendingImports): void {
  const { db, now } = deps;
  const store = storeOf(deps);
  db.transaction(() => {
    const stored = storedDigests(db);
    if (pending.probe !== undefined) {
      pending.probe.forEach((entry, index) => {
        store.create(
          {
            name: `probe ${entry.location} #${index + 1}`,
            scopes: ["probe"],
            location: entry.location,
            expiresAt: null,
            source: "file",
            secret: entry.token,
          },
          BOOTSTRAP_ACTOR,
        );
        stored.probe.add(sha256Hex(entry.token));
      });
      insertBootstrap(db, "probe", now(), pending.probe.length);
    }
    if (pending.admin !== undefined) {
      assertDistinctDigests(pending.admin, stored.probe, stored.all);
      for (const entry of pending.admin) {
        store.create(
          {
            name: entry.name,
            scopes: ADMIN_SCOPES,
            location: null,
            expiresAt: null,
            source: "file",
            secret: entry.token,
          },
          BOOTSTRAP_ACTOR,
        );
      }
      insertBootstrap(db, "admin", now(), pending.admin.length);
    }
  })();
}

function insertBootstrap(db: Database, kind: "probe" | "admin", at: number, count: number): void {
  db.query("INSERT INTO token_bootstrap (kind, imported_at, count) VALUES (?, ?, ?)").run(
    kind,
    at,
    count,
  );
}

function storeOf(deps: ImportDeps): TokenStore {
  const audit = createAuditLog(deps.db);
  return createTokenStore({
    db: deps.db,
    now: deps.now,
    generateId: deps.generateId ?? generateTokenId,
    generateSecret: deps.generateSecret ?? generateSecret,
    recordAudit: (entry) => {
      audit.record(entry);
    },
  });
}

/**
 * Run the pending imports, then build the token store over the database. Its index loads after
 * the import commits, so it holds the imported tokens.
 */
export function openTokenStore(deps: ImportDeps, pending: PendingImports): TokenStore {
  if (pending.probe !== undefined || pending.admin !== undefined) importTokens(deps, pending);
  return storeOf(deps);
}
