import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture
const http = { id: "a", name: "A", url: "http://a/", intervalMs: 1000 };
const tls = { id: "t", name: "T", type: "tls", host: "example.com", intervalMs: 1000 };

test("unknown key at the top level is rejected", () => {
  assert.throws(() => parseConfig({ checks: [http], check: [] }), {
    message: 'unknown key "check" in the top level',
  });
});

test("unknown key in a check is rejected and named with its index", () => {
  assert.throws(() => parseConfig({ checks: [http, { ...http, id: "b", keywrod: "x" }] }), {
    message: 'unknown key "keywrod" in checks[1]',
  });
  assert.throws(() => parseConfig({ checks: [{ ...tls, retries: 1 }] }), {
    message: 'unknown key "retries" in checks[0]',
  });
});

test("unknown key in a maintenance window is rejected", () => {
  const w = { checkId: "a", start: "2030-01-01T00:00:00Z", end: "2030-01-01T01:00:00Z", note: "n" };
  assert.throws(() => parseConfig({ checks: [http], maintenance: [{ ...w, notes: "x" }] }), {
    message: 'unknown key "notes" in maintenance[0]',
  });
  assert.equal(parseConfig({ checks: [http], maintenance: [w] }).maintenance.length, 1);
});

test("unknown key in a component is rejected", () => {
  const component = { id: "c", name: "C", checkIds: ["a"] };
  assert.throws(
    () => parseConfig({ checks: [http], components: [{ ...component, colour: "x" }] }),
    {
      message: /components\[0\].*colour/,
    },
  );
});
