import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const TOKEN = "test-token-east-0123456789abcdef";
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const CHECK: Check = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };

function down(t: number, location = "default"): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status: "down",
    statusCode: 500,
    latencyMs: 1,
    reason: "HTTP 500",
    location,
    attempts: 1,
  };
}

test("ingest: the same (check, location, timestamp) is stored and counted once", () => {
  const db = openDb(":memory:");
  const events: string[] = [];
  const s = createService(db, { onIncident: (e) => events.push(e) });
  s.upsertChecks([CHECK]);
  assert.equal(s.ingest(down(1)), true);
  assert.equal(s.ingest(down(1)), false);
  assert.equal(s.listResults("c1", 10).length, 1);
  // Three downs open the incident; repeats of them must not move the counter or open a second one.
  s.ingest(down(2));
  s.ingest(down(2));
  s.ingest(down(3));
  s.ingest(down(3));
  assert.equal(s.listChecks()[0]?.consecutiveDown, 3);
  assert.equal(s.listIncidents("open").length, 1);
  assert.deepEqual(events, ["opened"]);
  assert.equal(s.listResults("c1", 10).length, 3);
});

test("ingest: another location or another timestamp is a new sample", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([CHECK]);
  assert.equal(s.ingest(down(1, "a")), true);
  assert.equal(s.ingest(down(1, "b")), true);
  assert.equal(s.ingest(down(2, "a")), true);
});

test("ingest: a repeat does not touch the location tracker", () => {
  let t = 1000;
  const s = createService(openDb(":memory:"), { now: () => t, locationSilentMs: 500 });
  s.upsertChecks([CHECK]);
  s.ingest(down(900, "a"));
  t = 1400;
  s.ingest(down(900, "a"));
  t = 1600;
  // Seen at 1000, not 1400: the repeat did not refresh it.
  assert.equal(s.listLocations()[0]?.state, "silent");
});

test("POST /results twice: 204 both times, one row, one metric count", async () => {
  const service = createService(openDb(":memory:"));
  service.upsertChecks([CHECK]);
  const metrics = createMetrics();
  const server = createApiServer(service, {
    tokens: [{ location: "default", token: TOKEN }],
    now: () => 1000,
    metrics,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/results`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(down(500)),
      });
      assert.equal(res.status, 204);
    }
    assert.equal(service.listResults("c1", 10).length, 1);
    assert.match(metrics.render(), /pulse_api_results_ingested_total\{location="default"\} 1\n/);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
});

test("ingest: two heartbeat samples in one millisecond are both kept", () => {
  const s = createService(openDb(":memory:"));
  s.upsertChecks([{ id: "hb", name: "HB", type: "heartbeat", period: 1000, grace: 0 }]);
  const ping: Result = { ...down(10, "heartbeat"), checkId: "hb", status: "up", reason: null };
  assert.equal(s.ingest(ping), true);
  assert.equal(s.ingest(ping), true);
  assert.equal(s.listResults("hb", 10).length, 2);
});
