import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { handleTokenRoute, tokenPathOf, tokenRouteOf } from "./token-routes.ts";
import { createTokenStore } from "./token-store.ts";

const ID = `tok_${"a".repeat(24)}`;

test("the parser and the route label tell /self from /:id", () => {
  const cases: [string, string | null][] = [
    ["/admin/tokens", "/admin/tokens"],
    ["/admin/tokens/self", "/admin/tokens/self"],
    [`/admin/tokens/${ID}`, "/admin/tokens/:id"],
    ["/admin/tokens/selfx", "/admin/tokens/:id"],
    ["/admin/tokens/Self", "/admin/tokens/:id"],
    ["/admin/tokens/self/rotate", "/admin/tokens/:id/rotate"],
    ["/admin/tokens/self/revoke", "/admin/tokens/:id/revoke"],
    ["/admin/tokens/self/", null],
    ["/admin/tokens/self/other", null],
  ];
  for (const [path, route] of cases) {
    const parsed = tokenPathOf(path);
    expect(parsed === null ? null : tokenRouteOf(parsed)).toBe(route);
  }
  expect(tokenPathOf("/admin/tokens/self")).toEqual({
    id: undefined,
    action: undefined,
    isSelf: true,
  });
  expect(tokenPathOf("/admin/tokens/self/rotate")).toEqual({
    id: "self",
    action: "rotate",
    isSelf: false,
  });
});

let dir = "";
let db: Database;
let server: Server;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulse-token-routes-"));
  db = openDb(join(dir, "pulse.db"));
  const store = createTokenStore({
    db,
    now: () => 1_800_000_000_000,
    generateSecret: () => `pulse_${"s".repeat(43)}`,
    generateId: () => ID,
    recordAudit: () => undefined,
  });
  const deps = { store, now: () => 1_800_000_000_000, info: () => undefined };
  // A caller whose row is gone: authentication passed, but the store read finds nothing.
  const caller = {
    id: `tok_${"0".repeat(24)}`,
    name: "gone",
    scopes: ["admin" as const],
    location: null,
  };
  server = createServer((req, res) => {
    const path = tokenPathOf(req.url ?? "");
    if (path === null) throw new Error("test path is not a token path");
    void handleTokenRoute(deps, req, res, path, caller);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("/self answers 404 when the caller's row is missing", async () => {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/admin/tokens/self`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "token not found" });
});
