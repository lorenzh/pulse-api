import { Database } from "bun:sqlite";
import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorResponse, TokensResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const T = Date.parse("2030-03-01T12:00:00Z");
const ADMIN = "admin-throttle-0123456789abcdef0123456789";
const OTHER = "other-admin-0123456789abcdef0123456789abc";
const PROBE = "probe-throttle-0123456789";
const HB = "heartbeat-secret-0123456789";

let clock = T;
let dir = "";
let checksFile = "";
let api: RunningApi;
const lines: string[] = [];

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
};

/** One request on its own connection from loopback address `peer`. */
function call(
  peer: string,
  method: string,
  path: string,
  token?: string,
  extra: { body?: unknown; headers?: Record<string, string>; port?: number } = {},
): Promise<Reply> {
  const body = extra.body === undefined ? "" : JSON.stringify(extra.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: extra.port ?? api.port,
        localAddress: peer,
        agent: false,
        method,
        path,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === "" ? {} : { "content-type": "application/json" }),
          "content-length": String(Buffer.byteLength(body)),
          ...extra.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function fail10(peer: string, path = "/admin/config"): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await call(peer, "GET", path, "wrong")).status, 401);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-throttle-"));
  checksFile = join(dir, "checks.json");
  writeFileSync(
    checksFile,
    `${JSON.stringify(
      {
        checks: [
          { id: "x", name: "X", url: "https://x.invalid/", intervalMs: 1000 },
          { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0, secret: HB },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({
      tokens: [
        { name: "ops", token: ADMIN },
        { name: "other", token: OTHER },
      ],
    }),
  );
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "pulse.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => lines.push(line),
    openDb: (path) => openDb(path),
  });
});

afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the 11th failure in 60 s answers 429 with Retry-After until exactly the window end", async () => {
  clock = T;
  const peer = "127.0.1.1";
  await fail10(peer);
  const blocked = await call(peer, "GET", "/admin/config", "wrong");
  assert.equal(blocked.status, 429);
  assert.deepEqual(JSON.parse(blocked.text) as ErrorResponse, { error: "too many requests" });
  assert.equal(blocked.text, '{"error":"too many requests"}');
  assert.equal(blocked.headers["retry-after"], "60");
  assert.equal(blocked.headers["www-authenticate"], undefined);
  assert.equal(blocked.headers["x-content-type-options"], "nosniff");
  assert.equal(
    blocked.headers["content-security-policy"],
    "default-src 'none'; frame-ancestors 'none'",
  );
  assert.equal(blocked.headers["referrer-policy"], "no-referrer");
  assert.equal(blocked.headers["x-pulse-contract"], "1");
  clock = T + 59_001;
  const late = await call(peer, "GET", "/admin/config", ADMIN);
  assert.deepEqual([late.status, late.headers["retry-after"]], [429, "1"]);
  clock = T + 60_000;
  assert.equal((await call(peer, "GET", "/admin/config", ADMIN)).status, 200);
});

test("token and audit routes keep no-store on 429", async () => {
  clock = T + 1_000_000;
  const peer = "127.0.1.2";
  await fail10(peer, "/admin/tokens");
  for (const path of ["/admin/tokens", "/admin/audit"]) {
    const r = await call(peer, "GET", path, ADMIN);
    assert.equal(r.status, 429, path);
    assert.equal(r.headers["cache-control"], "no-store", path);
  }
});

test("routes and kinds share one budget; reconnects and forwarding headers do not help", async () => {
  clock = T + 2_000_000;
  const peer = "127.0.1.3";
  for (let i = 0; i < 4; i += 1)
    assert.equal((await call(peer, "GET", "/admin/config")).status, 401);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(peer, "GET", "/admin/tokens", "wrong")).status, 401);
  }
  for (let i = 0; i < 3; i += 1) {
    const r = await call(peer, "POST", "/manual-incidents", PROBE, { body: {} });
    assert.equal(r.status, 403);
  }
  const spoofed = await call(peer, "GET", "/admin/audit", ADMIN, {
    headers: { "x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.9" },
  });
  assert.equal(spoofed.status, 429);
  // Another loopback address is another client.
  assert.equal((await call("127.0.1.4", "GET", "/admin/config", ADMIN)).status, 200);
});

test("a blocked valid token is not authenticated and a blocked write changes nothing", async () => {
  clock = T + 3_000_000;
  const peer = "127.0.1.5";
  const view = await call(peer, "GET", "/admin/config", ADMIN);
  assert.equal(view.status, 200);
  await fail10(peer);
  clock = T + 3_030_000;
  const before = readFileSync(checksFile);
  const audits = auditCount();
  const write = await call(peer, "POST", "/admin/checks", ADMIN, {
    body: { id: "y", name: "Y", url: "https://y.invalid/", intervalMs: 1000 },
    headers: { "if-match": String(view.headers.etag) },
  });
  assert.equal(write.status, 429);
  assert.deepEqual(readFileSync(checksFile), before);
  assert.equal(auditCount(), audits);
  const list = await call("127.0.1.6", "GET", "/admin/tokens", OTHER);
  const ops = (JSON.parse(list.text) as TokensResponse).tokens.find((t) => t.name === "ops");
  assert.equal(ops?.lastUsedAt, T + 3_000_000);
});

test("50 concurrent wrong tokens give exactly 10 x 401 and 40 x 429", async () => {
  clock = T + 4_000_000;
  const peer = "127.0.1.7";
  const replies = await Promise.all(
    Array.from({ length: 50 }, () => call(peer, "GET", "/admin/config", "wrong")),
  );
  const statuses = replies.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 10);
  assert.equal(statuses.filter((s) => s === 429).length, 40);
});

test("public, ops, probe and heartbeat routes are not throttled", async () => {
  clock = T + 5_000_000;
  const peer = "127.0.1.8";
  await fail10(peer);
  assert.equal((await call(peer, "GET", "/admin/config", ADMIN)).status, 429);
  for (const path of ["/checks", "/healthz", "/metrics"]) {
    assert.equal((await call(peer, "GET", path)).status, 200, path);
  }
  assert.equal((await call(peer, "GET", "/probe/checks", PROBE)).status, 200);
  const result = {
    checkId: "x",
    timestamp: clock,
    status: "up",
    statusCode: 200,
    latencyMs: 3,
    reason: null,
    attempts: 1,
    location: "eu",
  };
  assert.equal((await call(peer, "POST", "/results", PROBE, { body: result })).status, 204);
  assert.equal((await call(peer, "POST", `/heartbeat/job/${HB}`)).status, 204);
  // Method and unknown-path answers come before the auth point.
  assert.equal((await call(peer, "GET", "/admin/nope", ADMIN)).status, 404);
});

test("the feature-off 404 comes before the throttle", async () => {
  const probeOnly = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "probe-only.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  });
  try {
    for (let i = 0; i < 12; i += 1) {
      const r = await call("127.0.1.9", "POST", "/manual-incidents", "wrong", {
        port: probeOnly.port,
        body: {},
      });
      assert.equal(r.status, 404);
    }
  } finally {
    await probeOnly.close();
  }
});

test("metrics and logs show the 429 by route pattern only, never client data or secrets", async () => {
  const metrics = await call("127.0.1.10", "GET", "/metrics");
  assert.match(
    metrics.text,
    /\npulse_api_admin_auth_throttled_total\{route="\/admin\/config"\} \d+\n/,
  );
  assert.match(
    metrics.text,
    /\npulse_api_http_requests_total\{route="\/admin\/config",code="429"\} \d+\n/,
  );
  const throttled = lines.filter((l) => l.includes("admin auth throttled"));
  assert.ok(throttled.length > 0);
  const text = `${metrics.text}\n${lines.join("\n")}`;
  for (const leak of ["127.0.1.", "203.0.113", "wrong", ADMIN, OTHER, PROBE, "Bearer"]) {
    assert.ok(!text.includes(leak), leak);
  }
  for (const line of throttled) assert.doesNotMatch(line, /"level":"error"|stack/);
});

function auditCount(): number {
  const db = new Database(join(dir, "pulse.db"), { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  } finally {
    db.close();
  }
}
