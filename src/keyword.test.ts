import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, ChecksResponse, HttpCheck } from "@lorenzh/pulse-contract";
import { ConfigError, parseChecks } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";
import { openTokenStore } from "./token-import.ts";

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

test("service: keyword persists across restart and is cleared when dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-keyword-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
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

test("db: a check without keyword reads none, and a keyword can be set", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([base]);
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
    tokenStore: openTokenStore(
      { db: openDb(":memory:"), now: () => 0 },
      {
        probe: [{ location: "default", token: "test-token-default-0123456789" }],
        admin: undefined,
      },
    ),
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

test("service: keyword of a check removed from the file is cleared, results stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-keyword-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "k.db");
  const kept: Check = { ...base, id: "kept", keyword: "stay" };
  const removed: Check = { ...base, id: "gone", keyword: "bye" };
  const s1 = createService(openDb(path));
  s1.upsertChecks([kept, removed]);
  s1.ingest({
    checkId: "gone",
    timestamp: 1,
    status: "up",
    statusCode: 200,
    latencyMs: 5,
    location: "default",
    reason: null,
    attempts: 1,
  });
  const db2 = openDb(path);
  const s2 = createService(db2);
  s2.upsertChecks([kept]);
  const list = s2.listChecks();
  assert.equal((list.find((c) => c.id === "kept") as HttpCheck).keyword, "stay");
  assert.equal(
    (
      db2.prepare("SELECT keyword FROM checks WHERE id = 'gone'").get() as {
        keyword: string | null;
      }
    ).keyword,
    null,
  );
  assert.equal(s2.listResults("gone", 10).length, 1);
  s2.upsertChecks([]);
  assert.equal(
    s2.listChecks().some((c) => "keyword" in c),
    false,
  );
  assert.equal(s2.listChecks().length, 0);
});
