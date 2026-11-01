import { Database } from "bun:sqlite";
import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditEntry,
  type AuditPage,
  validateAuditEntry,
  validateAuditPage,
  validateTokenSecretResponse,
} from "@lorenzh/pulse-contract";
import { createAuditLog } from "./audit-log.ts";
import { openDb } from "./db.ts";
import { type RunningApi, type StartDeps, startApi } from "./start.ts";

const T = 1_800_000_000_000;
const PROBE = "probe-audit-0123456789abcdef";
const ADMIN = "admin-audit-0123456789abcdef";
const SENTINELS = [
  "audit-sentinel-header-0001",
  "audit-sentinel-body-0002",
  "https://audit-sentinel-url-0003.invalid/",
  "audit-sentinel-hb-0004",
];

let dir = "";
let checksFile = "";
let tokensFile = "";
let adminFile = "";
const logLines: string[] = [];

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
    write: (_level, line) => {
      logLines.push(line);
    },
    openDb: (path) => openDb(path),
  };
}

function freshChecks(): void {
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "x", name: "X", url: "https://x.invalid/", intervalMs: 1000 }],
    }),
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-audit-"));
  checksFile = join(dir, "checks.json");
  tokensFile = join(dir, "tokens.json");
  adminFile = join(dir, "admin-tokens.json");
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }));
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
  ifMatch?: string,
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function etag(api: RunningApi): Promise<string> {
  const reply = await call(api, "GET", "/admin/config", ADMIN);
  const value = reply.headers.get("etag");
  if (value === null) throw new Error("no etag");
  return value;
}

async function page(api: RunningApi, query: string): Promise<AuditPage> {
  const reply = await call(api, "GET", `/admin/audit${query}`, ADMIN);
  assert.equal(reply.status, 200, reply.text);
  const parsed = validateAuditPage(JSON.parse(reply.text));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const ids = (p: AuditPage): number[] => p.entries.map((e) => e.id);

const INCIDENT = { title: "t", impact: "minor", componentIds: [], message: "m" };

test("an admin write appears in the audit query without secret values", async () => {
  freshChecks();
  logLines.length = 0;
  const dbPath = join(dir, "secrecy.db");
  const api = await startApi(deps(dbPath));
  try {
    const reader = await call(api, "POST", "/admin/tokens", ADMIN, {
      name: "reader",
      scopes: ["read", "checks"],
    });
    assert.equal(reader.status, 201);
    const parsedReader = validateTokenSecretResponse(JSON.parse(reader.text));
    if (!parsedReader.ok) throw new Error(parsedReader.error);
    const readerSecret = parsedReader.value.secret;

    const check = {
      id: "audited",
      name: "Audited",
      url: SENTINELS[2],
      intervalMs: 10_000,
      method: "POST",
      headers: { "x-sentinel": SENTINELS[0] },
      body: SENTINELS[1],
    };
    const created = await call(api, "POST", "/admin/checks", ADMIN, check, await etag(api));
    assert.equal(created.status, 201, created.text);
    const heartbeat = {
      id: "hb",
      name: "HB",
      type: "heartbeat",
      period: 86_400_000,
      grace: 3_600_000,
      secret: SENTINELS[3],
    };
    const hb = await call(api, "POST", "/admin/checks", ADMIN, heartbeat, await etag(api));
    assert.equal(hb.status, 201, hb.text);

    const query = await call(api, "GET", "/admin/audit", ADMIN);
    assert.equal(query.status, 200);
    assert.equal(query.headers.get("cache-control"), "no-store");
    const parsedPage = validateAuditPage(JSON.parse(query.text));
    if (!parsedPage.ok) throw new Error(parsedPage.error);
    const entry = parsedPage.value.entries.find(
      (e) => e.action === "check.create" && e.target.id === "audited",
    );
    assert.ok(entry);
    assert.equal(entry.target.id, "audited");
    assert.equal(entry.actor.name, "ops");
    assert.ok(validateAuditEntry(entry).ok);

    const exported = await call(api, "GET", "/admin/audit/export", ADMIN);
    assert.equal(exported.status, 200);

    const db = new Database(dbPath, { readonly: true });
    let cells = "";
    try {
      cells = JSON.stringify(db.query("SELECT * FROM audit_log").all());
    } finally {
      db.close();
    }
    const digest = createHash("sha256").update(ADMIN).digest("hex");
    const forbidden = [...SENTINELS, ADMIN, `Bearer ${ADMIN}`, digest];
    const logs = logLines.join("\n");
    for (const value of forbidden) {
      for (const [where, text] of [
        ["query", query.text],
        ["export", exported.text],
        ["cells", cells],
        ["logs", logs],
      ]) {
        assert.equal(text?.includes(value), false, `${value} in ${where}`);
      }
    }

    assert.equal((await call(api, "GET", "/admin/audit", PROBE)).status, 403);
    assert.equal((await call(api, "GET", "/admin/audit", readerSecret)).status, 403);
    assert.equal((await call(api, "GET", "/admin/audit/export", readerSecret)).status, 403);
  } finally {
    await api.close();
  }
});

test("an audit walk never skips an entry committed later", async () => {
  freshChecks();
  const api = await startApi(deps(join(dir, "walk.db")));
  try {
    // The bootstrap imports give ids 1 and 2; three incidents give 3 to 5.
    for (let i = 0; i < 3; i++) {
      assert.equal((await call(api, "POST", "/manual-incidents", ADMIN, INCIDENT)).status, 201);
    }
    const seen: number[] = [];
    const first = await page(api, "?limit=2");
    assert.deepEqual([ids(first), first.nextBefore], [[5, 4], 4]);
    seen.push(...ids(first));
    // Two entries commit during the walk.
    for (let i = 0; i < 2; i++) {
      assert.equal((await call(api, "POST", "/manual-incidents", ADMIN, INCIDENT)).status, 201);
    }
    const second = await page(api, "?limit=2&before=4");
    assert.deepEqual([ids(second), second.nextBefore], [[3, 2], 2]);
    seen.push(...ids(second));
    const third = await page(api, "?limit=2&before=2");
    assert.deepEqual([ids(third), third.nextBefore], [[1], null]);
    seen.push(...ids(third));
    const fresh = await page(api, "?limit=2");
    assert.deepEqual(ids(fresh), [7, 6]);
    seen.push(...ids(fresh));
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7],
    );
  } finally {
    await api.close();
  }

  // The export walk: started at largest id 5, batches of 2, entries added between batches.
  const db = openDb(":memory:");
  try {
    const log = createAuditLog(db);
    const record = (n: number): AuditEntry =>
      log.record({
        at: T + n,
        actor: { tokenId: null, name: "bootstrap" },
        action: "token.import",
        target: { kind: "token", id: `tok_${n}` },
        revision: null,
      });
    for (let n = 1; n <= 5; n++) record(n);
    const exported: number[] = [];
    for (const batch of log.batches({}, 2)) {
      exported.push(...batch.map((e) => e.id));
      record(100 + exported.length);
    }
    assert.deepEqual(exported, [1, 2, 3, 4, 5]);
  } finally {
    db.close();
  }
});

test("audit entries keep check ids of any length", async () => {
  freshChecks();
  const api = await startApi(deps(join(dir, "long.db")));
  const long = "x".repeat(300);
  try {
    const check = { id: long, name: "Long", url: "https://long.invalid/", intervalMs: 10_000 };
    const created = await call(api, "POST", "/admin/checks", ADMIN, check, await etag(api));
    assert.equal(created.status, 201, created.text);
    const removed = await call(
      api,
      "DELETE",
      `/admin/checks/${long}`,
      ADMIN,
      undefined,
      await etag(api),
    );
    assert.equal(removed.status, 204, removed.text);
    const result = await page(api, `?targetId=${long}`);
    assert.deepEqual(
      result.entries.map((e) => [e.action, e.target.id]),
      [
        ["check.delete", long],
        ["check.create", long],
      ],
    );
  } finally {
    await api.close();
  }
});

test("audit paging, parameter checks and the export", async () => {
  freshChecks();
  const dbPath = join(dir, "paging.db");
  let api = await startApi(deps(dbPath));
  await api.close();
  // The bootstrap gave 2 entries; 248 more make 250.
  const db = openDb(dbPath);
  try {
    const log = createAuditLog(db);
    for (let n = 3; n <= 250; n++) {
      log.record({
        at: T + n,
        actor: { tokenId: null, name: "seed" },
        action: "manual-incident.create",
        target: { kind: "manual-incident", id: String(n) },
        revision: null,
      });
    }
  } finally {
    db.close();
  }
  api = await startApi(deps(dbPath));
  let lines: string[] = [];
  try {
    const p1 = await page(api, "?limit=100");
    assert.deepEqual(
      [ids(p1)[0], ids(p1).at(-1), ids(p1).length, p1.nextBefore],
      [250, 151, 100, 151],
    );
    const p2 = await page(api, "?limit=100&before=151");
    assert.deepEqual(
      [ids(p2)[0], ids(p2).at(-1), ids(p2).length, p2.nextBefore],
      [150, 51, 100, 51],
    );
    const p3 = await page(api, "?limit=100&before=51");
    assert.deepEqual(
      [ids(p3)[0], ids(p3).at(-1), ids(p3).length, p3.nextBefore],
      [50, 1, 50, null],
    );

    for (const bad of [
      "limit=0",
      "limit=1001",
      "limit=1.5",
      "before=0",
      "since=10&until=10",
      "action=check.drop",
      "foo=1",
    ]) {
      const reply = await call(api, "GET", `/admin/audit?${bad}`, ADMIN);
      assert.equal(reply.status, 400, bad);
    }
    const unknown = await call(api, "GET", "/admin/audit?foo=secret-value-9", ADMIN);
    assert.ok(unknown.text.includes("foo") && !unknown.text.includes("secret-value-9"));

    const exported = await call(api, "GET", "/admin/audit/export", ADMIN);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(exported.headers.get("cache-control"), "no-store");
    lines = exported.text.split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, 250);
    const exportedIds = lines.map((line) => {
      const parsed = validateAuditEntry(JSON.parse(line));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value.id;
    });
    assert.deepEqual(
      exportedIds,
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
    assert.equal((await call(api, "GET", "/admin/audit/export?limit=10", ADMIN)).status, 400);
    assert.equal((await call(api, "GET", "/admin/audit/export?before=10", ADMIN)).status, 400);
    assert.equal((await call(api, "POST", "/admin/audit", ADMIN, {})).status, 405);
  } finally {
    await api.close();
  }
  api = await startApi(deps(dbPath));
  try {
    const again = await call(api, "GET", "/admin/audit/export", ADMIN);
    assert.equal(again.text, `${lines.join("\n")}\n`);
  } finally {
    await api.close();
  }
});
