import { Database } from "bun:sqlite";
import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_MAX_BODY_BYTES,
  type TokenSecretResponse,
  validateTokenMetadata,
  validateTokenSecretResponse,
  validateTokensResponse,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const T = 1_800_000_000_000;
const PROBE = "probe-tokens-0123456789abcdef";
const ADMIN = "admin-tokens-0123456789abcdef";

let dir = "";
let checksFile = "";
let tokensFile = "";
let adminFile = "";

function deps(dbPath: string): StartDeps {
  return {
    env: {
      PORT: "0",
      PULSE_DB: dbPath,
      PULSE_CHECKS_FILE: checksFile,
      PULSE_TOKENS_FILE: tokensFile,
      PULSE_API_ADMIN_TOKENS_FILE: adminFile,
    },
    now: () => T,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  };
}

/** A fresh database path: the first start imports the probe and the admin file. */
function bootstrap(name: string): string {
  return join(dir, name);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-tokens-"));
  checksFile = join(dir, "checks.json");
  tokensFile = join(dir, "tokens.json");
  adminFile = join(dir, "admin-tokens.json");
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }));
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "x", name: "X", url: "https://x.invalid/", intervalMs: 1000 }],
    }),
  );
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Reply {
  status: number;
  text: string;
  headers: Headers;
}

async function call(
  api: RunningApi,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function secretOf(reply: Reply): TokenSecretResponse {
  const parsed = validateTokenSecretResponse(JSON.parse(reply.text));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function occurrences(file: string, needle: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file).toString("latin1").split(needle).length - 1;
}

test("a stored token is not readable in clear", async () => {
  const dbPath = bootstrap("clear.db");
  let api = await startApi(deps(dbPath));
  try {
    const created = await call(api, "POST", "/admin/tokens", ADMIN, {
      name: "ci",
      scopes: ["admin"],
    });
    assert.equal(created.status, 201);
    const { token, secret } = secretOf(created);
    assert.equal(created.headers.get("location"), `/admin/tokens/${token.id}`);
    assert.equal((await call(api, "GET", "/admin/tokens", secret)).status, 200);

    for (const suffix of ["", "-wal", "-shm"]) {
      assert.equal(occurrences(`${dbPath}${suffix}`, secret), 0, `secret in ${suffix || "db"}`);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query("SELECT secret_sha256 FROM token_secrets WHERE token_id = ?")
        .all(token.id) as { secret_sha256: string }[];
      assert.deepEqual(rows, [
        { secret_sha256: createHash("sha256").update(secret).digest("hex") },
      ]);
    } finally {
      db.close();
    }

    await api.close();
    api = await startApi(deps(dbPath));
    assert.equal((await call(api, "GET", "/admin/tokens", secret)).status, 200);
    const one = await call(api, "GET", `/admin/tokens/${token.id}`, secret);
    assert.equal(one.status, 200);
    const metadata: unknown = JSON.parse(one.text);
    assert.ok(typeof metadata === "object" && metadata !== null && !("secret" in metadata));
    assert.ok(validateTokenMetadata(metadata).ok);
    assert.ok(!one.text.includes(secret));
  } finally {
    await api.close();
  }
});

test("create validation, the grant rule, limits and the last admin", async () => {
  const api = await startApi(deps(bootstrap("create.db")));
  try {
    const create = (body: unknown, token = ADMIN) =>
      call(api, "POST", "/admin/tokens", token, body);
    const clock: [number, number][] = [
      [1_800_000_000_000, 400],
      [1_799_999_999_999, 400],
      [1_800_000_000_001, 201],
      [1_800_000_000_000 + 315_360_000_000, 201],
      [1_800_000_000_000 + 315_360_000_001, 400],
    ];
    for (const [expiresAt, status] of clock) {
      const r = await create({ name: "c", scopes: ["read"], expiresAt });
      assert.equal(r.status, status, `expiresAt ${expiresAt}`);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }

    const invalid: unknown[] = [
      { name: "x", scopes: [] },
      { name: "x", scopes: ["owner"] },
      { name: "x", scopes: ["read", "read"] },
      { name: "x", scopes: ["probe", "read"] },
      { name: "x", scopes: ["probe"] },
      { name: "x", scopes: ["read"], location: "eu" },
      { name: "x", scopes: ["probe"], location: "l".repeat(65) },
      { name: "   ", scopes: ["read"] },
      { name: "n".repeat(101), scopes: ["read"] },
      { name: "a\u0000b", scopes: ["read"] },
      { name: "x", scopes: ["read"], expiresAt: 1.5 },
      { name: "x", scopes: ["read"], expiresAt: 0 },
      { name: "x", scopes: ["read"], expiresAt: -1 },
      { name: "x", scopes: ["read"], expiresAt: "1" },
      { name: "x", scopes: ["read"], secret: "chosen-by-client-0000" },
      "{not json",
    ];
    for (const body of invalid) {
      assert.equal((await create(body)).status, 400, JSON.stringify(body));
    }

    const caller = secretOf(await create({ name: "inc", scopes: ["admin", "incidents"] })).secret;
    const checks = await create({ name: "x", scopes: ["checks"] }, caller);
    assert.equal(checks.status, 403);
    assert.deepEqual(JSON.parse(checks.text), { error: "forbidden" });
    assert.equal(
      (await create({ name: "x", scopes: ["probe"], location: "eu" }, caller)).status,
      403,
    );
    assert.equal((await create({ name: "x", scopes: ["incidents"] }, caller)).status, 201);

    const checker = secretOf(await create({ name: "ac", scopes: ["admin", "checks"] })).secret;
    const full = secretOf(
      await create({ name: "full", scopes: ["read", "checks", "incidents", "admin"] }),
    );
    assert.equal(
      (await call(api, "POST", `/admin/tokens/${full.token.id}/revoke`, checker)).status,
      403,
    );

    const big = JSON.stringify({ name: "x", scopes: ["read"], pad: "p".repeat(5000) });
    const wrong = await create(big, "wrong-token-0123456789abcdef");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("cache-control"), "no-store");
    assert.equal((await create(big)).status, 413);
    const getWithBody = (path: string, size = 5000): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: api.port, method: "GET", path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.setHeader("authorization", `Bearer ${ADMIN}`);
        req.setHeader("content-length", String(size));
        req.on("error", reject);
        req.end("p".repeat(size));
      });
    assert.deepEqual(
      [
        await getWithBody("/admin/tokens"),
        await getWithBody(`/admin/tokens/tok_${"0".repeat(24)}`),
      ],
      [413, 413],
    );
    // Every other admin GET route keeps the admin body limit.
    const adminLimit = ADMIN_MAX_BODY_BYTES + 1;
    assert.deepEqual(
      [
        await getWithBody("/admin/config", adminLimit),
        await getWithBody("/admin/audit", adminLimit),
        await getWithBody("/admin/audit/export", adminLimit),
      ],
      [413, 413, 413],
    );

    assert.equal((await call(api, "GET", "/admin/tokens/tok_nope", ADMIN)).status, 404);
    const missing = await call(api, "GET", `/admin/tokens/tok_${"0".repeat(24)}`, ADMIN);
    assert.deepEqual(
      [missing.status, JSON.parse(missing.text)],
      [404, { error: "token not found" }],
    );
    assert.equal((await call(api, "GET", "/admin/tokens/x", PROBE)).status, 403);
    const listed = await call(api, "GET", "/admin/tokens", ADMIN);
    assert.ok(validateTokensResponse(JSON.parse(listed.text)).ok);
    assert.equal(listed.headers.get("cache-control"), "no-store");
  } finally {
    await api.close();
  }
});

test("revoking the last active admin answers 409", async () => {
  const api = await startApi(deps(bootstrap("last.db")));
  try {
    const listed = JSON.parse((await call(api, "GET", "/admin/tokens", ADMIN)).text) as {
      tokens: { id: string; name: string }[];
    };
    const ops = listed.tokens.find((t) => t.name === "ops");
    assert.ok(ops !== undefined);
    const last = await call(api, "POST", `/admin/tokens/${ops.id}/revoke`, ADMIN);
    assert.equal(last.status, 409);
    assert.deepEqual(JSON.parse(last.text), { error: "cannot revoke the last active admin token" });
    assert.equal((await call(api, "GET", "/admin/tokens", ADMIN)).status, 200);

    const second = secretOf(
      await call(api, "POST", "/admin/tokens", ADMIN, { name: "two", scopes: ["admin"] }),
    );
    assert.equal(
      (await call(api, "POST", `/admin/tokens/${ops.id}/revoke`, ADMIN, {})).status,
      200,
    );
    assert.equal((await call(api, "GET", "/admin/tokens", ADMIN)).status, 401);
    const again = await call(api, "POST", `/admin/tokens/${second.token.id}/revoke`, second.secret);
    assert.equal(again.status, 409);
    assert.equal(
      (await call(api, "POST", `/admin/tokens/${second.token.id}/revoke`, second.secret, { a: 1 }))
        .status,
      400,
    );
  } finally {
    await api.close();
  }
});

test("a probe token created with a padded location accepts results for that location", async () => {
  const api = await startApi(deps(bootstrap("padded.db")));
  try {
    const made = await call(api, "POST", "/admin/tokens", ADMIN, {
      name: "probe eu",
      scopes: ["probe"],
      location: " eu ",
    });
    assert.equal(made.status, 201);
    const { token, secret } = secretOf(made);
    assert.equal(token.location, "eu");
    const result = (location: string) => ({
      checkId: "x",
      timestamp: T,
      status: "up",
      statusCode: 200,
      latencyMs: 3,
      reason: null,
      attempts: 1,
      location,
    });
    const statuses = [
      (await call(api, "POST", "/results", secret, result("eu"))).status,
      (await call(api, "POST", "/results", secret, result(" eu "))).status,
    ];
    assert.deepEqual(statuses, [204, 204]);
  } finally {
    await api.close();
  }
});
