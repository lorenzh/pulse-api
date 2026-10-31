import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ADMIN_AUTH_LOG_WINDOW_MS,
  createAdminAuthFailures,
  tokenKindOf,
} from "./admin-auth-failures.ts";
import { createMetrics } from "./metrics.ts";

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

test("tokenKindOf: missing without a Bearer header, probe for a probe token, else unknown", () => {
  const isProbe = (h: string | undefined) => h === "Bearer probe-token";
  assert.equal(tokenKindOf(undefined, isProbe), "missing");
  assert.equal(tokenKindOf("Basic abc", isProbe), "missing");
  assert.equal(tokenKindOf("Bearer a b", isProbe), "missing");
  assert.equal(tokenKindOf("Bearer probe-token", isProbe), "probe");
  assert.equal(tokenKindOf("Bearer not-a-real-token-123456", isProbe), "unknown");
});
