import { test } from "bun:test";
import assert from "node:assert/strict";
import { ConfigError, parseConfig } from "./config.ts";

const SECRET = "hb-secret-0123456789abcdef";
const hb = { id: "job", name: "Job", type: "heartbeat", period: 60000, secret: SECRET };

test("heartbeat config: grace defaults to 0 and the secret stays out of the check", () => {
  const { checks, secrets } = parseConfig({ checks: [hb] });
  assert.deepEqual(checks, [
    { id: "job", name: "Job", type: "heartbeat", period: 60000, grace: 0 },
  ]);
  assert.equal(secrets.get("job"), SECRET);
  assert.equal(JSON.stringify(checks).includes(SECRET), false);
});

test("heartbeat config: rejects what the spec forbids, without echoing the secret", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...hb, secret: undefined }, /checks\[0\]\.secret is required/],
    [{ ...hb, secret: "short" }, /checks\[0\]\.secret is required/],
    [{ ...hb, secret: "x".repeat(129) }, /checks\[0\]\.secret is required/],
    [{ ...hb, secret: "has space 0123456789abc" }, /checks\[0\]\.secret is required/],
    [{ ...hb, period: undefined }, /checks\[0\]\.period must be an integer/],
    [{ ...hb, period: 999 }, /checks\[0\]\.period must be an integer/],
    [{ ...hb, period: 1.5 }, /checks\[0\]\.period must be an integer/],
    [{ ...hb, period: 86_400_001 }, /checks\[0\]\.period must be an integer/],
    [{ ...hb, grace: -1 }, /checks\[0\]\.grace must be an integer/],
    [{ ...hb, grace: "1" }, /checks\[0\]\.grace must be an integer/],
    [{ ...hb, url: "https://x.example/" }, /unknown key "url"/],
    [{ ...hb, intervalMs: 1000 }, /unknown key "intervalMs"/],
    [{ ...hb, timeoutMs: 1000 }, /unknown key "timeoutMs"/],
    [{ ...hb, keyword: "x" }, /unknown key "keyword"/],
    [{ ...hb, retries: 1 }, /unknown key "retries"/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(
      () => parseConfig({ checks: [raw] }),
      (err: unknown) =>
        err instanceof ConfigError && pattern.test(err.message) && !err.message.includes(SECRET),
    );
  }
});

test("heartbeat config: secret is rejected on other types; duplicate ids stay rejected", () => {
  assert.throws(
    () =>
      parseConfig({
        checks: [
          { id: "a", name: "A", url: "https://x.example/", intervalMs: 1000, secret: SECRET },
        ],
      }),
    /unknown key "secret"/,
  );
  assert.throws(() => parseConfig({ checks: [hb, hb] }), /duplicate check id "job"/);
  assert.throws(
    () => parseConfig({ checks: [{ ...hb, type: "cron" }] }),
    /"http", "tls", "tcp", "dns", "domain" or "heartbeat"/,
  );
});
