import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CheckStatus } from "@lorenzh/pulse-contract";
import {
  applyResult,
  type CheckStateSnapshot,
  INITIAL_STATE,
  type IncidentAction,
} from "./state.ts";

function run(statuses: CheckStatus[]) {
  let s: CheckStateSnapshot = INITIAL_STATE;
  const actions: IncidentAction[] = [];
  for (const st of statuses) {
    const r = applyResult(s, st);
    s = r.next;
    actions.push(r.action);
  }
  return { s, actions };
}

const table: Array<[string, CheckStatus[], IncidentAction[], string, number]> = [
  ["2 downs: no incident", ["down", "down"], ["none", "none"], "down", 2],
  ["3 downs: one opens", ["down", "down", "down"], ["none", "none", "open"], "down", 3],
  [
    "4th down: still one",
    ["down", "down", "down", "down"],
    ["none", "none", "open", "none"],
    "down",
    4,
  ],
  ["up resolves", ["down", "down", "down", "up"], ["none", "none", "open", "resolve"], "up", 0],
  [
    "up-down-down-up: none",
    ["up", "down", "down", "up"],
    ["none", "none", "none", "none"],
    "up",
    0,
  ],
  [
    "second incident after recovery",
    ["down", "down", "down", "up", "down", "down", "down"],
    ["none", "none", "open", "resolve", "none", "none", "open"],
    "down",
    3,
  ],
];

for (const [name, input, actions, state, count] of table) {
  test(`state: ${name}`, () => {
    const r = run(input);
    assert.deepEqual(r.actions, actions);
    assert.equal(r.s.state, state);
    assert.equal(r.s.consecutiveDown, count);
  });
}

test("state: unknown before any result", () => {
  assert.equal(INITIAL_STATE.state, "unknown");
  assert.equal(INITIAL_STATE.consecutiveDown, 0);
});
