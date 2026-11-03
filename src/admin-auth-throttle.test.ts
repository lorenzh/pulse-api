import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TokenScope } from "@lorenzh/pulse-contract";
import { createAdminAuthFailures } from "./admin-auth-failures.ts";
import { type AdminAuthRequest, createAdminAuthThrottle } from "./admin-auth-throttle.ts";
import { createMetrics } from "./metrics.ts";
import type { AuthResult } from "./token-store.ts";

const ADMIN = "admin-throttle-0123456789abcdef0123456789";
const READ = "read-throttle-0123456789abcdef0123456789ab";
const SHORT = "short-admin-0123456";

const SCOPES: Record<string, TokenScope[]> = {
  [ADMIN]: ["admin", "checks", "incidents", "read"],
  [READ]: ["read"],
  [SHORT]: ["admin"],
};

function setup() {
  let t = 1_000_000;
  const lines: { message: string; fields: Record<string, string> }[] = [];
  const metrics = createMetrics();
  let authCalls = 0;
  const tokens = {
    authenticate(secret: string): AuthResult {
      authCalls += 1;
      const scopes = SCOPES[secret];
      if (scopes === undefined) return { kind: "unknown" };
      return { kind: "ok", token: { id: "t", name: "ops", scopes, location: null } };
    },
  };
  const warn = (message: string, fields: Record<string, string>): void => {
    lines.push({ message, fields });
  };
  const authFailures = createAdminAuthFailures({ now: () => t, warn, metrics });
  const throttle = createAdminAuthThrottle({ tokens, authFailures, now: () => t, warn, metrics });
  const ask = (
    secret: string | undefined,
    extra: Partial<AdminAuthRequest> = {},
  ): ReturnType<typeof throttle.authorize> =>
    throttle.authorize({
      remoteAddress: "127.0.0.1",
      authorization: secret === undefined ? undefined : `Bearer ${secret}`,
      route: "/admin/config",
      permission: "config-read",
      ...extra,
    });
  return {
    ask,
    lines,
    metrics,
    authCalls: () => authCalls,
    at: (offset: number) => {
      t = 1_000_000 + offset;
    },
  };
}

function kinds(results: { kind: string }[]): string[] {
  return results.map((r) => r.kind);
}

test("ten failures keep 401, then 429 until exactly the window end", () => {
  const { ask, at, authCalls } = setup();
  at(0);
  const first = Array.from({ length: 10 }, () => ask("wrong"));
  assert.deepEqual(
    first.map((r) => (r.kind === "denied" ? r.status : r.kind)),
    Array(10).fill(401),
  );
  const calls = authCalls();
  assert.deepEqual(ask("wrong"), { kind: "throttled", retryAfterSeconds: 60 });
  // A valid credential is blocked too, without authenticating.
  assert.deepEqual(ask(ADMIN), { kind: "throttled", retryAfterSeconds: 60 });
  assert.equal(authCalls(), calls);
  at(59_001);
  assert.deepEqual(ask(ADMIN), { kind: "throttled", retryAfterSeconds: 1 });
  at(59_999);
  assert.deepEqual(ask(ADMIN), { kind: "throttled", retryAfterSeconds: 1 });
  at(60_000);
  assert.equal(ask(ADMIN).kind, "ok");
  // A failure now opens a new window with count 1: nine more stay denied.
  assert.deepEqual(kinds(Array.from({ length: 10 }, () => ask("wrong"))), Array(10).fill("denied"));
  assert.equal(ask("wrong").kind, "throttled");
});

test("Retry-After stays 1..60 when the clock goes backwards; blocked requests do not extend", () => {
  const { ask, at } = setup();
  at(0);
  for (let i = 0; i < 10; i += 1) ask("wrong");
  at(-5_000);
  assert.deepEqual(ask("wrong"), { kind: "throttled", retryAfterSeconds: 60 });
  at(30_000);
  for (let i = 0; i < 20; i += 1) ask("wrong");
  at(60_000);
  assert.equal(ask(ADMIN).kind, "ok");
});

test("a success neither counts nor resets the window", () => {
  const { ask, at } = setup();
  at(0);
  for (let i = 0; i < 9; i += 1) assert.equal(ask("wrong").kind, "denied");
  assert.equal(ask(ADMIN).kind, "ok");
  assert.deepEqual(ask("wrong"), { kind: "denied", status: 401 });
  assert.equal(ask(ADMIN).kind, "throttled");
});

test("every denial kind and every route share one budget per client", () => {
  const { ask, at } = setup();
  at(0);
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(ask(undefined), { kind: "denied", status: 401 });
    assert.deepEqual(ask(SHORT, { route: "/admin/tokens", permission: "token-admin" }), {
      kind: "denied",
      status: 401,
    });
    assert.deepEqual(ask(READ, { route: "/manual-incidents", permission: "incident-write" }), {
      kind: "denied",
      status: 403,
    });
  }
  assert.deepEqual(ask("wrong", { route: "/admin/audit" }), { kind: "denied", status: 401 });
  assert.equal(ask(ADMIN, { route: "/admin/audit" }).kind, "throttled");
});

test("clients are keyed by address: mapped IPv4 and one /64 share, other peers do not", () => {
  const { ask, at } = setup();
  at(0);
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture, never contacted
  const mapped = "::ffff:127.0.0.1";
  for (let i = 0; i < 10; i += 1) ask("wrong", { remoteAddress: mapped });
  assert.equal(ask(ADMIN).kind, "throttled");
  assert.equal(ask(ADMIN, { remoteAddress: "127.0.0.2" }).kind, "ok");
  for (let i = 0; i < 10; i += 1) ask("wrong", { remoteAddress: "2001:db8::1" });
  assert.equal(ask(ADMIN, { remoteAddress: "2001:db8::2" }).kind, "throttled");
  assert.equal(ask(ADMIN, { remoteAddress: "2001:db8:0:1::1" }).kind, "ok");
});

test("metrics: 10 failures and 3 blocked give 10 and 3; no throttle series before blocking", () => {
  const { ask, at, metrics } = setup();
  at(0);
  for (let i = 0; i < 10; i += 1) ask("wrong");
  assert.doesNotMatch(metrics.render(), /pulse_api_admin_auth_throttled_total\{/);
  for (let i = 0; i < 3; i += 1) ask("wrong");
  const text = metrics.render();
  assert.match(
    text,
    /\npulse_api_admin_auth_failures_total\{route="\/admin\/config",status="401"\} 10\n/,
  );
  assert.match(text, /\npulse_api_admin_auth_throttled_total\{route="\/admin\/config"\} 3\n/);
  assert.match(
    text,
    /# HELP pulse_api_admin_auth_throttled_total Admin requests refused with 429 by the auth throttle, by route pattern\.\n/,
  );
});

test("the throttled line is logged once per route and 60 s with the suppressed count only", () => {
  const { ask, at, lines } = setup();
  at(0);
  for (let i = 0; i < 10; i += 1) ask("wrong", { remoteAddress: "203.0.113.9" });
  for (let i = 0; i < 4; i += 1) ask("wrong", { remoteAddress: "203.0.113.9" });
  ask("wrong", { remoteAddress: "203.0.113.9", route: "/admin/tokens" });
  at(59_999);
  ask("wrong", { remoteAddress: "203.0.113.9" });
  const throttled = lines.filter((l) => l.message === "admin auth throttled");
  assert.deepEqual(throttled, [
    { message: "admin auth throttled", fields: { route: "/admin/config", suppressed: "0" } },
    { message: "admin auth throttled", fields: { route: "/admin/tokens", suppressed: "0" } },
  ]);
  at(60_001);
  // The client's window ended at 60 000, so it fails normally; block it again to log.
  for (let i = 0; i < 10; i += 1) ask("wrong", { remoteAddress: "203.0.113.9" });
  ask("wrong", { remoteAddress: "203.0.113.9" });
  assert.deepEqual(lines.filter((l) => l.message === "admin auth throttled").at(-1), {
    message: "admin auth throttled",
    fields: { route: "/admin/config", suppressed: "4" },
  });
  const text = JSON.stringify(lines);
  for (const leak of ["203.0.113", "wrong", ADMIN, "Bearer"]) assert.ok(!text.includes(leak));
});
