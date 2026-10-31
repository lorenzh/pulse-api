import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const TOKEN = "test-token-east-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-0123456789abcdef";
const NOW = Date.parse("2026-10-28T12:00:00Z");

let dir: string;
let api: RunningApi;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-allow-"));
  const checksFile = join(dir, "checks.json");
  const tokensFile = join(dir, "tokens.json");
  const adminFile = join(dir, "admin.json");
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }],
      components: [{ id: "site", name: "Site", checkIds: ["a"] }],
    }),
  );
  writeFileSync(tokensFile, JSON.stringify({ tokens: [{ location: "eu", token: TOKEN }] }));
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN_TOKEN }] }));
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "t.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_TOKENS_FILE: tokensFile,
      PULSE_API_ADMIN_TOKENS_FILE: adminFile,
    },
    now: () => NOW,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  });
  base = `http://127.0.0.1:${api.port}`;
});

afterAll(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

async function expect405(
  method: string,
  path: string,
  allow: string,
  token?: string,
): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  const label = `${method} ${path}`;
  assert.equal(res.status, 405, label);
  assert.equal(res.headers.get("allow"), allow, label);
  const body = await res.text();
  if (method === "HEAD") assert.equal(body, "", label);
  else assert.deepEqual(JSON.parse(body), { error: "method not allowed" }, label);
}

test("/results answers 405 with Allow: POST, before auth", async () => {
  await expect405("GET", "/results", "POST");
  await expect405("PUT", "/results", "POST", TOKEN);
});

test("the read routes answer 405 with Allow: GET", async () => {
  const paths = [
    "/checks",
    "/probe/checks",
    "/uptime",
    "/latency",
    "/components",
    "/components/uptime",
    "/incidents",
    "/locations",
    "/maintenance",
    "/checks/a/results",
    "/checks/a/latency",
    "/checks/unknown/results",
  ];
  for (const path of paths) await expect405("POST", path, "GET");
  await expect405("HEAD", "/checks", "GET");
});

test("the heartbeat answers 405 with Allow: GET, POST for any id", async () => {
  await expect405("DELETE", "/heartbeat/x", "GET, POST");
  await expect405("DELETE", "/heartbeat/a", "GET, POST");
  await expect405("PUT", "/heartbeat/x/some-secret", "GET, POST");
});

test("admin answers 405 after auth with Allow by path shape", async () => {
  for (const section of ["checks", "components", "maintenance"]) {
    await expect405("GET", `/admin/${section}`, "POST", ADMIN_TOKEN);
    await expect405("PATCH", `/admin/${section}/a`, "PUT, DELETE", ADMIN_TOKEN);
    await expect405("POST", `/admin/${section}/a`, "PUT, DELETE", ADMIN_TOKEN);
    await expect405("PUT", `/admin/${section}`, "POST", ADMIN_TOKEN);
    const unauthorized = await fetch(`${base}/admin/${section}`, { method: "GET" });
    assert.equal(unauthorized.status, 401);
    const item = await fetch(`${base}/admin/${section}/a`, { method: "PATCH" });
    assert.equal(item.status, 401);
  }
});
