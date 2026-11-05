import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdminCheckInput } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { startApi } from "./start.ts";

test("security: an own __proto__ header cannot disappear before input validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-proto-header-"));
  const admin = "security-review-admin-0123456789abcdef";
  writeFileSync(join(dir, "checks.json"), JSON.stringify({ checks: [] }));
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "test", token: "security-review-probe-0123456789" }] }),
  );
  writeFileSync(
    join(dir, "admin.json"),
    JSON.stringify({ tokens: [{ name: "ops", token: admin }] }),
  );
  const api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "api.db"),
      PULSE_CHECKS_FILE: join(dir, "checks.json"),
      PULSE_TOKENS_FILE: join(dir, "tokens.json"),
      PULSE_API_ADMIN_TOKENS_FILE: join(dir, "admin.json"),
    },
    now: () => 1700000000000,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: () => undefined,
    openDb: (path) => openDb(path),
  });
  try {
    const base = `http://127.0.0.1:${api.port}`;
    const headers = { authorization: `Bearer ${admin}` };
    const config = await fetch(`${base}/admin/config`, { headers });
    const input: unknown = JSON.parse(
      '{"id":"proto","name":"Proto","url":"http://127.0.0.1:1/","intervalMs":60000,"headers":{"__proto__":null}}',
    );
    assert.equal(validateAdminCheckInput(input).ok, false);
    const response = await fetch(`${base}/admin/checks`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "if-match": config.headers.get("etag") ?? "",
      },
      body: JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, 422, `strict input must reject an own __proto__ header: ${body}`);
    const after = await fetch(`${base}/admin/config`, { headers });
    assert.equal(after.headers.get("etag"), config.headers.get("etag"));
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
