import { expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { createRuntimeStore, reportState, runtimeRevision } from "./runtime-store.ts";

test("revisions: literal hashes of the status generations, independent per resource", () => {
  // Computed outside the code with `printf 'status\n0' | sha256sum` and `printf 'status\n1' | ...`.
  expect(runtimeRevision("status", 0)).toBe(
    "sha256-e745901c33c149e10fea4b781eea5793f79c2b0aa2f834507eda7efdd4956f12",
  );
  expect(runtimeRevision("status", 1)).toBe(
    "sha256-db12b2ebd38951957def4aa20d4593a6db0725c438a6af63cef6fe7752a9df92",
  );
  expect(runtimeRevision("status", 0)).not.toBe(runtimeRevision("notify", 0));
  expect(runtimeRevision("status", 0)).not.toBe(runtimeRevision("status", 1));
});

test("generations start at 0 and bump one resource at a time", () => {
  const db = openDb(":memory:");
  try {
    const store = createRuntimeStore(db);
    expect([store.generation("status"), store.generation("notify")]).toEqual([0, 0]);
    expect(store.bumpGeneration("status")).toBe(1);
    expect(store.bumpGeneration("status")).toBe(2);
    expect([store.generation("status"), store.generation("notify")]).toEqual([2, 0]);
    expect(store.bumpGeneration("notify")).toBe(1);
  } finally {
    db.close();
  }
});

test("status settings: {} before the first save, then the whole document is replaced", () => {
  const db = openDb(":memory:");
  try {
    const store = createRuntimeStore(db);
    expect(store.statusSettings()).toEqual({});
    store.replaceStatusSettings({ name: "Acme", showLatency: false });
    store.replaceStatusSettings({ showSlos: false });
    expect(store.statusSettings()).toEqual({ showSlos: false });
    expect(db.query("SELECT COUNT(*) AS n FROM status_settings").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test("reports: one row per service, last write wins; a report bumps no generation", () => {
  const db = openDb(":memory:");
  try {
    const store = createRuntimeStore(db);
    expect(store.report("status")).toBeNull();
    store.replaceReport("status", { json: '{"a":1}', receivedAt: 10 });
    store.replaceReport("status", { json: '{"a":2}', receivedAt: 20 });
    expect(store.report("status")).toEqual({ json: '{"a":2}', receivedAt: 20 });
    expect(store.report("notify")).toBeNull();
    expect(store.generation("status")).toBe(0);
  } finally {
    db.close();
  }
});

test("report state: never without a report, fresh at 180000 ms, stale at 180001 ms", () => {
  const stored = { json: "{}", receivedAt: 1_000 };
  expect(reportState(null, 5)).toBe("never");
  expect(reportState(stored, 1_000)).toBe("fresh");
  expect(reportState(stored, 181_000)).toBe("fresh");
  expect(reportState(stored, 181_001)).toBe("stale");
});
