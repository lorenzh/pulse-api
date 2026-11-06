import { expect, test } from "bun:test";
import type { Check } from "@lorenzh/pulse-contract";
import type { CheckDefinition } from "./check-store.ts";
import type { Config, FileMaintenanceWindow } from "./config.ts";
import { createConfigHolder } from "./config-holder.ts";
import { effectiveMaintenance } from "./effective-maintenance.ts";
import type { WindowDefinition } from "./maintenance-store.ts";

const check = (id: string): Check => ({
  id,
  name: id,
  url: `https://${id}.example/`,
  intervalMs: 60_000,
});
const definition = (id: string): CheckDefinition => ({
  check: check(id),
  secretSha256: null,
  createdAt: 1,
  updatedAt: 1,
});
const stored = (id: string, checkIds: string[], note = "db upgrade"): WindowDefinition => ({
  id,
  checkIds,
  start: 1000,
  end: 2000,
  note,
  createdAt: 1,
  updatedAt: 1,
});
const config = (checks: Check[], maintenance: FileMaintenanceWindow[] = []): Config => ({
  checks,
  secrets: new Map(),
  maintenance,
  components: [],
});

test("a file window with the id of a database window shadows all of it", () => {
  const file: FileMaintenanceWindow[] = [
    { id: "w", checkId: "a", start: 5, end: 6, note: "file note" },
  ];
  const result = effectiveMaintenance(file, [stored("w", ["a", "b"])], new Set(["a", "b"]));
  expect(result.windows).toEqual([{ checkId: "a", start: 5, end: 6, note: "file note" }]);
  expect(result.shadowed.map((d) => d.id)).toEqual(["w"]);
  expect(result.effective).toEqual([]);
});

test("file windows come first, then each effective check id of a database window", () => {
  const file: FileMaintenanceWindow[] = [
    { id: "f", checkId: "c", start: 1000, end: 3000, note: "file" },
    { checkId: "a", start: 1, end: 2, note: "plain" },
  ];
  const result = effectiveMaintenance(
    file,
    [stored("w", ["b", "gone", "a"]), stored("x", ["a"], "second")],
    new Set(["a", "b", "c"]),
  );
  expect(result.windows).toEqual([
    { checkId: "c", start: 1000, end: 3000, note: "file" },
    { checkId: "a", start: 1, end: 2, note: "plain" },
    { checkId: "b", start: 1000, end: 2000, note: "db upgrade" },
    { checkId: "a", start: 1000, end: 2000, note: "db upgrade" },
    { checkId: "a", start: 1000, end: 2000, note: "second" },
  ]);
  for (const w of result.windows)
    expect(Object.keys(w)).toEqual(["checkId", "start", "end", "note"]);
  expect(result.effective.map((d) => d.checkIds)).toEqual([["b", "gone", "a"], ["a"]]);
});

test("the holder shadows, unshadows and projects only effective members", () => {
  const holder = createConfigHolder(
    config([check("a")], [{ id: "w", checkId: "a", start: 5, end: 6, note: "file note" }]),
    [definition("b")],
    new Map(),
    [stored("w", ["a", "b"])],
  );
  expect(holder.get().maintenance).toEqual([{ checkId: "a", start: 5, end: 6, note: "file note" }]);
  expect(holder.maintenance().shadowed.map((d) => d.id)).toEqual(["w"]);

  holder.set(config([check("a")]));
  expect(holder.get().maintenance.map((w) => w.checkId)).toEqual(["a", "b"]);
  expect(holder.maintenance().shadowed).toEqual([]);

  // A missing member stops projecting; the definition keeps it, and it applies again on return.
  holder.setDefinitions([]);
  expect(holder.get().maintenance.map((w) => w.checkId)).toEqual(["a"]);
  expect(holder.windowDefinitions()[0]?.checkIds).toEqual(["a", "b"]);
  holder.setDefinitions([definition("b")]);
  expect(holder.get().maintenance.map((w) => w.checkId)).toEqual(["a", "b"]);
});

test("the holder keeps one window array until a setter publishes a new one", () => {
  const holder = createConfigHolder(config([check("a")]), [], new Map(), [stored("w", ["a"])]);
  const first = holder.get().maintenance;
  expect(holder.get().maintenance).toBe(first);
  holder.setWindowDefinitions([stored("w", ["a"], "edited")]);
  const second = holder.get().maintenance;
  expect(second).not.toBe(first);
  expect(second[0]?.note).toBe("edited");
  expect(holder.get().maintenance).toBe(second);
  holder.setDefinitions([]);
  const third = holder.get().maintenance;
  expect(third).not.toBe(second);
  holder.set(config([check("a")]));
  expect(holder.get().maintenance).not.toBe(third);
});
