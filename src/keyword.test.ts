import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Check, ChecksResponse, HttpCheck } from "@lorenzh/pulse-contract";
import { ConfigError, parseChecks } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http/ftp literal is a local test fixture, never requested over a network
const base = { id: "k", name: "K", url: "http://x/", intervalMs: 1000 };

test("config: keyword is kept verbatim on an HTTP check and omitted when unset", () => {
  const [a, b] = parseChecks({
    checks: [
      { ...base, keyword: " Welcome " },
      { ...base, id: "k2" },
    ],
  });
  assert.equal((a as HttpCheck).keyword, " Welcome ");
  assert.equal("keyword" in (b as object), false);
});

test("config: keyword is rejected when empty, not a string, or on a TLS check", () => {
  const tls = { id: "t", name: "T", type: "tls", host: "example.com", intervalMs: 1000 };
  const cases: [unknown, RegExp][] = [
    [{ ...base, keyword: "" }, /checks\[0\]\.keyword must be a non-empty string/],
    [{ ...base, keyword: 5 }, /checks\[0\]\.keyword must be a non-empty string/],
    [{ ...tls, keyword: "x" }, /checks\[0\]\.keyword is not allowed on a tls check/],
    [{ ...tls, keyword: "" }, /checks\[0\]\.keyword is not allowed on a tls check/],
  ];
  for (const [check, message] of cases) {
    assert.throws(
      () => parseChecks({ checks: [check] }),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, message);
        return true;
      },
    );
  }
});

test("service: keyword persists across restart and is cleared when dropped", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-keyword-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "k.db");
  const withKeyword: Check = { ...base, keyword: "ok" };
  const db1 = openDb(path);
  createService(db1).upsertChecks([withKeyword]);
  db1.close();
  const s2 = createService(openDb(path));
  assert.equal((s2.listChecks()[0] as HttpCheck).keyword, "ok");
  s2.upsertChecks([base]);
  assert.equal("keyword" in s2.listChecks()[0]!, false);
});

test("db: an old database without the keyword column migrates", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-keyword-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE checks (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, timeout_ms INTEGER, state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_down INTEGER NOT NULL DEFAULT 0, last_result_at INTEGER, last_reason TEXT);
    INSERT INTO checks (id, name, url, interval_ms) VALUES ('k', 'K', 'http://x/', 1000);`);
  old.close();
  const s = createService(openDb(path));
  assert.equal("keyword" in s.listChecks()[0]!, false);
  s.upsertChecks([{ ...base, keyword: "ok" }]);
  assert.equal((s.listChecks()[0] as HttpCheck).keyword, "ok");
});

test("server: GET /checks serves the keyword only for checks that have one", async () => {
  const service = createService(openDb(":memory:"));
  service.upsertChecks([
    { ...base, keyword: "ok" },
    { ...base, id: "plain" },
  ]);
  const server = createApiServer(service, {
    tokens: [{ location: "default", token: "test-token-default-0123456789" }],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/checks`;
    const body = (await (await fetch(url)).json()) as ChecksResponse;
    const byId = new Map(body.map((c) => [c.id, c]));
    assert.equal((byId.get("k") as HttpCheck).keyword, "ok");
    assert.equal("keyword" in (byId.get("plain") as object), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
