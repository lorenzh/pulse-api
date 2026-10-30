import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CheckUptime, Component, Incident } from "@lorenzh/pulse-contract";
import { componentsUptime, componentsWithState } from "./components.ts";

const components: Component[] = [
  { id: "web", name: "Web", checkIds: ["a", "b"] },
  { id: "api", name: "API", checkIds: ["b", "c"] },
  { id: "idle", name: "Idle", checkIds: ["c"] },
];

const day = (date: string, uptime: number | null, results: number) => ({ date, uptime, results });
const uptime: CheckUptime[] = [
  { checkId: "a", days: [day("2030-01-01", 100, 10)], uptime: 100 },
  { checkId: "b", days: [day("2030-01-01", 50, 10)], uptime: 50 },
  { checkId: "c", days: [day("2030-01-01", null, 0)], uptime: null },
];
const incident = (id: number, checkId: string): Incident => ({
  id,
  checkId,
  openedAt: 1,
  resolvedAt: null,
  reason: null,
});

test("componentsWithState: combined state, weighted uptime, incident ids", () => {
  const states = [
    { id: "a", state: "up" as const },
    { id: "b", state: "down" as const },
    { id: "c", state: "unknown" as const },
  ];
  const out = componentsWithState(components, states, uptime, [
    incident(7, "b"),
    incident(3, "a"),
    incident(5, "b"),
  ]);
  assert.deepEqual(
    out.map((c) => [c.id, c.state, c.uptime, c.incidentIds]),
    [
      ["web", "down", 75, [3, 5, 7]],
      ["api", "down", 50, [5, 7]],
      ["idle", "unknown", null, []],
    ],
  );
});

test("componentsWithState: maintenance next to up is ignored; all maintenance shows", () => {
  const states = [
    { id: "a", state: "maintenance" as const },
    { id: "b", state: "up" as const },
    { id: "c", state: "maintenance" as const },
  ];
  const out = componentsWithState(components, states, uptime, []);
  assert.deepEqual(
    out.map((c) => c.state),
    ["up", "up", "maintenance"],
  );
});

test("componentsUptime: sums results of a shared check in each component", () => {
  const out = componentsUptime(components, uptime);
  assert.deepEqual(out[0], {
    componentId: "web",
    days: [day("2030-01-01", 75, 20)],
    uptime: 75,
  });
  assert.deepEqual(out[2]?.days, [day("2030-01-01", null, 0)]);
  assert.equal(out[2]?.uptime, null);
  assert.deepEqual(componentsUptime([], uptime), []);
});
