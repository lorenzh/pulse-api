import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ADMIN_AUTH_LOG_WINDOW_MS,
  adminAccess,
  createAdminAuthFailures,
} from "./admin-auth-failures.ts";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import { openTokenStore } from "./token-import.ts";

function setup() {
  let t = 0;
  const lines: { message: string; fields: Record<string, string> }[] = [];
  const metrics = createMetrics();
  const recorder = createAdminAuthFailures({
    now: () => t,
    warn: (message, fields) => lines.push({ message, fields }),
    metrics,
  });
  return {
    recorder,
    lines,
    metrics,
    at: (ms: number) => {
      t = ms;
    },
  };
}

test("one key logs once per window and reports the dropped count; the metric counts all", () => {
  const { recorder, lines, metrics, at } = setup();
  assert.equal(ADMIN_AUTH_LOG_WINDOW_MS, 60_000);
  for (const ms of [0, 1000, 59_999, 60_000, 60_001, 200_000]) {
    at(ms);
    recorder.record("/admin/checks", 401, "missing");
  }
  assert.deepEqual(lines, [
    {
      message: "admin auth failed",
      fields: { route: "/admin/checks", status: "401", token: "missing", suppressed: "0" },
    },
    {
      message: "admin auth failed",
      fields: { route: "/admin/checks", status: "401", token: "missing", suppressed: "2" },
    },
    {
      message: "admin auth failed",
      fields: { route: "/admin/checks", status: "401", token: "missing", suppressed: "1" },
    },
  ]);
  assert.match(
    metrics.render(),
    /pulse_api_admin_auth_failures_total\{route="\/admin\/checks",status="401"\} 6\n/,
  );
});

test("keys are independent: route, status and token kind each make their own key", () => {
  const { recorder, lines } = setup();
  recorder.record("/manual-incidents", 401, "missing");
  recorder.record("/manual-incidents", 401, "probe");
  recorder.record("/admin/checks", 401, "missing");
  recorder.record("/admin/checks", 403, "probe");
  assert.deepEqual(
    lines.map((l) => [l.fields.route, l.fields.status, l.fields.token]),
    [
      ["/manual-incidents", "401", "missing"],
      ["/manual-incidents", "401", "probe"],
      ["/admin/checks", "401", "missing"],
      ["/admin/checks", "403", "probe"],
    ],
  );
});

test("the same route pattern is one key, and no metric series exists before a failure", () => {
  const { recorder, lines, metrics } = setup();
  assert.doesNotMatch(metrics.render(), /pulse_api_admin_auth_failures_total\{/);
  recorder.record("/admin/checks/:id", 401, "missing");
  recorder.record("/admin/checks/:id", 401, "missing");
  assert.equal(lines.length, 1);
  assert.match(
    metrics.render(),
    /pulse_api_admin_auth_failures_total\{route="\/admin\/checks\/:id",status="401"\} 2\n/,
  );
});

const PROBE = "probe-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef";

function storeAt(clock: { t: number }) {
  const store = openTokenStore(
    { db: openDb(":memory:"), now: () => clock.t },
    { probe: [{ location: "eu", token: PROBE }], admin: [{ name: "ops", token: ADMIN }] },
  );
  const actor = { tokenId: null, name: "test" };
  const reader = store.create(
    { name: "reader", scopes: ["read"], location: null, expiresAt: 100, source: "api" },
    actor,
  );
  return { store, reader };
}

test("adminAccess: the D2 kinds missing, unknown, inactive, probe and scope", () => {
  const clock = { t: 0 };
  const { store, reader } = storeAt(clock);
  const kind = (header: string | undefined) => {
    const access = adminAccess(store, header, "config-write");
    return access.kind === "ok" ? "ok" : `${access.status} ${access.token}`;
  };
  assert.equal(kind(undefined), "401 missing");
  assert.equal(kind("Basic abc"), "401 missing");
  assert.equal(kind("Bearer not-a-real-token-123456"), "401 unknown");
  assert.equal(kind(`Bearer ${PROBE}`), "403 probe");
  assert.equal(kind(`Bearer ${reader.secret}`), "403 scope");
  assert.equal(kind(`Bearer ${ADMIN}`), "ok");
  clock.t = 100;
  assert.equal(kind(`Bearer ${reader.secret}`), "401 inactive");
});

test("no auth-failure line holds a token, its digest, its id or its name", () => {
  const clock = { t: 0 };
  const { store, reader } = storeAt(clock);
  const { recorder, lines } = setup();
  const headers = [undefined, "Bearer unknown-token-0123456789", `Bearer ${PROBE}`];
  headers.push(`Bearer ${reader.secret}`);
  for (const header of headers) {
    const access = adminAccess(store, header, "config-write");
    if (access.kind === "denied") recorder.record("/admin/checks", access.status, access.token);
  }
  clock.t = 100;
  const expired = adminAccess(store, `Bearer ${reader.secret}`, "config-write");
  if (expired.kind === "denied") recorder.record("/admin/checks", expired.status, expired.token);
  assert.deepEqual(
    lines.map((l) => l.fields.token),
    ["missing", "unknown", "probe", "scope", "inactive"],
  );
  const text = JSON.stringify(lines);
  const probeId = store.list().find((t) => t.scopes.includes("probe"))?.id ?? "missing id";
  for (const secret of [PROBE, reader.secret, "unknown-token-0123456789"]) {
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(createHash("sha256").update(secret).digest("hex")));
  }
  for (const word of [reader.token.id, reader.token.name, probeId, "probe eu #1"]) {
    assert.ok(!text.includes(word), word);
  }
});
