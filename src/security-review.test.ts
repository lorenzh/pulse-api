import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdminCheckInput, validateResultsResponse } from "@lorenzh/pulse-contract";
import { parseConfigText } from "./config.ts";
import { createConfigReloader } from "./config-reload.ts";
import { openDb } from "./db.ts";
import { validateResult } from "./server.ts";
import { type RunningApi, startApi } from "./start.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const PROBE = "security-probe-0123456789abcdef";
const ADMIN = "security-admin-0123456789abcdef";
const SECRET = "SECURITY-HEARTBEAT-SECRET-0123456789";
const HEADER = "SECURITY-HEADER-SENTINEL-0123456789";
const BODY = "SECURITY-BODY-SENTINEL-0123456789";
const URL_SENTINEL = "SECURITY-URL-SENTINEL-0123456789";
const CONFIG = {
  checks: [
    {
      id: "web",
      name: "Web",
      intervalMs: 60000,
      url: `https://example.invalid/${URL_SENTINEL}`,
      method: "POST",
      headers: { "x-secret": HEADER },
      body: BODY,
    },
    { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0, secret: SECRET },
  ],
};
const BYTES = Buffer.from(JSON.stringify(CONFIG));

function failedReload(failure: unknown): string[] {
  const lines: string[] = [];
  const reloader = createConfigReloader(
    {
      path: "/checks.json",
      fs: { stat: () => ({ mtimeMs: 2, size: BYTES.length, ino: 1 }), readFile: () => BYTES },
      onApply: () => {
        throw failure;
      },
      metrics: { recordConfigReload: () => undefined },
      log: (line) => lines.push(line),
    },
    { config: parseConfigText("/checks.json", BYTES.toString()), revision: "old", stampKey: "old" },
  );
  reloader.poll();
  return lines;
}

test("security: reload metadata rejects control characters and never reads the message", () => {
  for (const suffix of ["\t", "\r", "\n", "\r\n", "\u2028", "\u2029", " ", "x".repeat(65)]) {
    const error = new Error("unused");
    Object.defineProperty(error, "message", {
      get: () => {
        throw new Error("message getter ran");
      },
    });
    error.name = `Error${suffix}`;
    Object.defineProperty(error, "code", { value: `SQLITE_BUSY${suffix}` });
    assert.deepEqual(failedReload(error), [
      "config reload failed: /checks.json: cannot apply the configuration: Error",
    ]);
  }
  for (const failure of [null, undefined, { message: SECRET }, SECRET]) {
    assert.deepEqual(failedReload(failure), [
      "config reload failed: /checks.json: cannot apply the configuration: unknown error",
    ]);
  }
});

test("security: an accessor cannot swap a checked error name for checks-file secrets", () => {
  const message = `${HEADER}\n${SECRET}\r${BODY}\t${URL_SENTINEL}`;
  const error = new Error(message);
  let reads = 0;
  Object.defineProperty(error, "name", {
    get: () => {
      reads += 1;
      return reads === 1 ? "Error" : message;
    },
  });
  const lines = failedReload(error);
  assert.deepEqual(
    lines,
    ["config reload failed: /checks.json: cannot apply the configuration: Error"],
    "the log must contain only validated metadata, never checks-file values or line breaks",
  );
  assert.equal(reads, 0, "untrusted error metadata accessors must not execute");
});

test("security: result validation never invokes optional-field accessors", () => {
  let reads = 0;
  const body = {
    checkId: "web",
    timestamp: NOW,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
  };
  Object.defineProperty(body, "attempts", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("untrusted getter executed");
    },
  });
  assert.doesNotThrow(() => validateResult(body, NOW, () => undefined));
  assert.equal(reads, 0);
});

test("security: contract rejects required getters, array accessors and prototype keys without execution", () => {
  let reads = 0;
  const body = { timestamp: NOW, status: "up", statusCode: 200, latencyMs: 1, reason: null };
  Object.defineProperty(body, "checkId", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("getter");
    },
  });
  assert.equal(typeof validateResult(body, NOW, () => undefined), "string");
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("array getter");
    },
  });
  assert.equal(validateResultsResponse(array).ok, false);
  assert.equal(reads, 0);
  for (const key of ["__proto__", "constructor"]) {
    const input = JSON.parse(
      `{"id":"web","name":"Web","url":"https://example.invalid/","intervalMs":60000,"${key}":{"polluted":true}}`,
    );
    assert.equal(validateAdminCheckInput(input).ok, false);
  }
});

let api: RunningApi;
let dir: string;
const logs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-security-"));
  writeFileSync(join(dir, "checks.json"), BYTES);
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: PROBE }] }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }),
  );
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "test.db"),
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => logs.push(line),
    openDb: (path) => openDb(path),
  });
});

afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  body = "",
  token?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; allow: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: api.port,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            allow: res.headers.allow,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function expectAdminMethod(path: string, allow: string): Promise<void> {
  for (const method of ["GET", "PATCH"]) {
    for (const [token, expected] of [
      [undefined, 401],
      ["wrong-token", 401],
      [PROBE, 403],
      [ADMIN, 405],
    ] as const) {
      const res = await call(method, path, "{", token, { "if-match": "malformed" });
      assert.equal(res.status, expected, `${method} ${path}`);
      assert.equal(res.allow, expected === 405 ? allow : undefined);
      if (expected === 405) assert.equal(res.body, '{"error":"method not allowed"}');
    }
  }
}

test("security HTTP: admin auth precedes method and malformed-body checks on all changed shapes", async () => {
  for (const section of ["checks", "components", "maintenance"]) {
    for (const suffix of ["", "/web", "/missing", "/%ZZ", "/%2e%2e%2f"]) {
      await expectAdminMethod(`/admin/${section}${suffix}`, suffix === "" ? "POST" : "PUT, DELETE");
    }
  }
});

test("security HTTP: method checks reveal no heartbeat ids or secrets and keep public-route order", async () => {
  for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
    for (const id of ["job", "missing", "%ZZ"]) {
      const res = await call(method, `/heartbeat/${id}/${SECRET}`, "{", PROBE);
      assert.equal(res.status, 405);
      assert.equal(res.allow, "GET, POST");
      assert.equal(res.body, method === "HEAD" ? "" : '{"error":"method not allowed"}');
    }
  }
  for (const token of [undefined, "wrong", PROBE]) {
    assert.equal((await call("GET", "/results", "{", token)).status, 405);
    assert.equal((await call("POST", "/probe/checks", "{", token)).status, 405);
    assert.equal((await call("POST", "/results", "{", token)).status, token === PROBE ? 400 : 401);
    assert.equal(
      (await call("GET", "/probe/checks", "", token)).status,
      token === PROBE ? 200 : 401,
    );
  }
  const outputs = [
    logs.join("\n"),
    (await call("GET", "/checks")).body,
    (await call("GET", "/metrics")).body,
  ];
  for (const output of outputs) {
    for (const secret of [SECRET, HEADER, BODY, ADMIN, PROBE]) assert.ok(!output.includes(secret));
  }
  assert.ok(!logs.join("\n").includes(URL_SENTINEL));
});

test("security HTTP: oversized bodies across methods cannot reach a write", async () => {
  const huge = "x".repeat(1000001);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const res = await call(method, "/results", huge, PROBE);
    assert.equal(res.status, method === "POST" ? 413 : 405);
    const admin = await call(method, "/admin/checks/web", "x".repeat(1048577), ADMIN);
    assert.equal(admin.status, method === "PUT" || method === "DELETE" ? 413 : 405);
    const list = await call(method, "/admin/checks", "x".repeat(1048577), ADMIN);
    assert.equal(list.status, method === "POST" ? 413 : 405);
    const ping = await call(method, `/heartbeat/job/${SECRET}`, "x".repeat(1025));
    assert.equal(ping.status, method === "GET" || method === "POST" ? 413 : 405);
  }
  const config = await call("GET", "/admin/config", "", ADMIN);
  assert.equal(config.status, 200);
  assert.ok(config.body.includes('"id":"web"'));
  assert.equal((await call("GET", "/checks/web/results")).body, "[]");
  assert.equal((await call("GET", "/checks/job/results")).body, "[]");
});

test("security HTTP: result boundaries, wrong types and hostile keys reject without throwing", async () => {
  const base = {
    checkId: "web",
    timestamp: NOW,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
  };
  for (const [field, limit, past] of [
    ["reason", "x".repeat(1000), "x".repeat(1001)],
    ["attempts", 100, 101],
    ["latencyMs", 86400000, 86400001],
    ["certDaysLeft", 3000000, 3000001],
    ["certDaysLeft", -3000000, -3000001],
    ["timestamp", NOW + 60000, NOW + 60001],
    ["timestamp", NOW - 604800000, NOW - 604800001],
  ] as const) {
    assert.equal(
      (await call("POST", "/results", JSON.stringify({ ...base, [field]: past }), PROBE)).status,
      400,
      field,
    );
    assert.equal(
      (await call("POST", "/results", JSON.stringify({ ...base, [field]: limit }), PROBE)).status,
      204,
      field,
    );
  }
  for (const input of [
    null,
    [],
    1,
    "x",
    { ...base, attempts: null },
    { ...base, latencyMs: "1" },
    { ...base, checkId: "x".repeat(100000) },
  ]) {
    const result = await call("POST", "/results", JSON.stringify(input), PROBE);
    assert.ok(result.status === 400 || result.status === 404, String(result.status));
  }
});

test("security HTTP: admin rejects control characters, wrong types and unknown keys without exposing values", async () => {
  const base = { id: "new", name: "New", url: "https://example.invalid/", intervalMs: 60000 };
  for (const input of [
    null,
    [],
    { ...base, intervalMs: "60000" },
    { ...base, unknown: SECRET },
    { ...base, constructor: SECRET },
    JSON.parse(`${JSON.stringify(base).slice(0, -1)},"__proto__":{"sentinel":"${SECRET}"}}`),
    ...["\t", "\r", "\n"].map((control) => ({
      ...base,
      headers: { "x-secret": HEADER + control + SECRET },
    })),
  ]) {
    const config = await fetch(`http://127.0.0.1:${api.port}/admin/config`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const result = await call("POST", "/admin/checks", JSON.stringify(input), ADMIN, {
      "if-match": config.headers.get("etag") ?? "",
    });
    assert.equal(result.status, 422, JSON.stringify(input));
    assert.ok(!result.body.includes(SECRET) && !result.body.includes(HEADER));
  }
});
