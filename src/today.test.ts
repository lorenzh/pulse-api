import { test } from "bun:test";
import assert from "node:assert/strict";
import { nearestRank, summarizeLatencies } from "./latency.ts";
import {
  applyStored,
  dropOlderDays,
  emptyTodayState,
  insertSorted,
  sortedFrom,
  sortedView,
} from "./today.ts";

/** A small fixed-seed generator, so the random order is the same in every run. */
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

test("sorted insert: [10, 20, 30, 40] in any order gives p50 20 and p95 40", () => {
  const values = sortedFrom([]);
  for (const v of [30, 10, 40, 20]) insertSorted(values, v);
  assert.deepEqual([...sortedView(values)], [10, 20, 30, 40]);
  assert.deepEqual(summarizeLatencies(sortedView(values)), { p50Ms: 20, p95Ms: 40, count: 4 });
});

test("sorted insert: random order matches a sorted plain array, with ties, 0 and fractions", () => {
  const random = seeded(42);
  const plain: number[] = [0, 0, 7.25];
  const values = sortedFrom([0, 0, 7.25]);
  for (let i = 0; i < 1000; i++) {
    // Rounded to tenths so that ties are frequent.
    const v = Math.round(random() * 500) / 10;
    plain.push(v);
    insertSorted(values, v);
  }
  plain.sort((a, b) => a - b);
  assert.equal(values.length, 1003);
  assert.deepEqual([...sortedView(values)], plain);
  for (const p of [1, 50, 95, 99, 100]) {
    assert.equal(nearestRank(sortedView(values), p), nearestRank(plain, p));
  }
});

test("sorted insert: the capacity grows past the initial size", () => {
  const values = sortedFrom([1, 2, 3]);
  for (let i = 0; i < 40; i++) insertSorted(values, 2.5);
  assert.equal(values.length, 43);
  assert.ok(values.data.length >= 43);
  assert.equal(sortedView(values)[0], 1);
  assert.equal(sortedView(values)[42], 3);
});

test("apply: counts a row of the record's day, drops other days and missing records", () => {
  const state = emptyTodayState();
  state.uptime.set("c1", { day: 10, good: 2, total: 3 });
  state.latency.set("c1", { day: 10, values: sortedFrom([5, 9]) });
  applyStored(state, { checkId: "c1", day: 10, isDown: false, latencyMs: 7 });
  applyStored(state, { checkId: "c1", day: 10, isDown: true, latencyMs: 9999 });
  applyStored(state, { checkId: "c1", day: 11, isDown: false, latencyMs: 1 });
  applyStored(state, { checkId: "c2", day: 10, isDown: false, latencyMs: 1 });
  assert.deepEqual(state.uptime.get("c1"), { day: 10, good: 3, total: 5 });
  const latency = state.latency.get("c1");
  assert.deepEqual(latency && [...sortedView(latency.values)], [5, 7, 9]);
  assert.equal(state.uptime.has("c2"), false);
  assert.equal(state.latency.has("c2"), false);
});

test("drop older days: only the records of earlier days go", () => {
  const state = emptyTodayState();
  state.uptime.set("old", { day: 9, good: 1, total: 1 });
  state.uptime.set("new", { day: 10, good: 1, total: 1 });
  state.latency.set("old", { day: 9, values: sortedFrom([1]) });
  state.latency.set("new", { day: 10, values: sortedFrom([1]) });
  dropOlderDays(state, 10);
  assert.deepEqual([...state.uptime.keys()], ["new"]);
  assert.deepEqual([...state.latency.keys()], ["new"]);
});
