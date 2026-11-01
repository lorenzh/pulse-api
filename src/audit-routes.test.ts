import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AuditEntry } from "@lorenzh/pulse-contract";
import { type ExportSink, writeAuditExport } from "./audit-routes.ts";

function entry(id: number): AuditEntry {
  return {
    id,
    at: 1000 + id,
    actor: { tokenId: "tok_000000000000000000000001", name: "admin" },
    action: "manual-incident.create",
    target: { kind: "manual-incident", id: String(id) },
    revision: null,
  };
}

function fakeSink(): ExportSink & {
  chunks: string[];
  ended: boolean;
  emit(event: "drain" | "close"): void;
} {
  const listeners = new Map<string, (() => void)[]>();
  const sink = {
    chunks: [] as string[],
    ended: false,
    destroyed: false,
    write(chunk: string): boolean {
      sink.chunks.push(chunk);
      return false;
    },
    end(): void {
      sink.ended = true;
    },
    once(event: "drain" | "close", listener: () => void): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: "drain" | "close"): void {
      const waiting = listeners.get(event) ?? [];
      listeners.clear();
      if (event === "close") sink.destroyed = true;
      for (const fn of waiting) fn();
    },
  };
  return sink;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the export waits for drain when the response buffer is full", async () => {
  const batches = Array.from({ length: 10 }, (_, i) => [entry(i + 1)]);
  let read = 0;
  function* lazy(): Generator<AuditEntry[]> {
    for (const batch of batches) {
      read++;
      yield batch;
    }
  }
  const sink = fakeSink();
  const done = writeAuditExport(lazy(), sink);
  await tick();
  assert.deepEqual([sink.chunks.length, read, sink.ended], [1, 1, false]);
  sink.emit("drain");
  await tick();
  assert.deepEqual([sink.chunks.length, read], [2, 2]);
  sink.emit("close");
  await done;
  assert.deepEqual([sink.chunks.length, read, sink.ended], [2, 2, false]);
  assert.equal(sink.chunks[0], `${JSON.stringify(entry(1))}\n`);
});
