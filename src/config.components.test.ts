import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "./config.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture
const a = { id: "a", name: "A", url: "http://a/", intervalMs: 1000 };
const b = { ...a, id: "b", name: "B" };
const web = { id: "web", name: "Web", checkIds: ["a", "b"], group: "Services" };

test("config: a missing components key means no components", () => {
  assert.deepEqual(parseConfig({ checks: [a] }).components, []);
});

test("config: components keep their order and a check may be in several", () => {
  const second = { id: "api", name: "API", description: "Public API", checkIds: ["b"] };
  const { components } = parseConfig({ checks: [a, b], components: [web, second] });
  assert.deepEqual(components, [web, second]);
});

test("config: rejects invalid components with a path", () => {
  const cases: [unknown, RegExp][] = [
    ["x", /components.*array/],
    [[web, web], /duplicate component id "web"/],
    [
      [{ ...web, checkIds: ["zzz"] }],
      /components\[0\]\.checkIds\[0\] must reference a configured check/,
    ],
    [[{ ...web, checkIds: [] }], /components\[0\]\.checkIds/],
    [[{ ...web, checkIds: ["a", "a"] }], /components\[0\]\.checkIds/],
    [[{ ...web, colour: "red" }], /components\[0\].*colour/],
    [[web, { ...web, id: "Bad Id" }], /components\[1\]\.id/],
    [[{ ...web, name: "x".repeat(101) }], /components\[0\]\.name/],
  ];
  for (const [components, message] of cases) {
    assert.throws(() => parseConfig({ checks: [a, b], components }), { message });
  }
});
