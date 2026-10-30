import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type LocationsResponse, validateLocationsResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createMetrics } from "./metrics.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

let server: Server;
let base: string;

beforeAll(async () => {
  const service = createService(openDb(":memory:"), { now: () => 100_000, locationSilentMs: 1000 });
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
  service.upsertChecks([{ id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 }]);
  for (const [location, timestamp] of [
    ["west", 90_000],
    ["east", 99_000],
  ] as const) {
    service.ingest({
      checkId: "c1",
      timestamp,
      status: "up",
      statusCode: 200,
      latencyMs: 1,
      reason: null,
      location,
      attempts: 1,
    });
  }
  server = createApiServer(service, {
    tokens: [],
    now: () => 100_000,
    metrics: createMetrics({ listLocations: () => service.listLocations() }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
);

test("GET /locations: public, sorted, valid against the contract", async () => {
  const res = await fetch(`${base}/locations`);
  assert.equal(res.status, 200);
  const body: unknown = await res.json();
  const verdict = validateLocationsResponse(body);
  assert.ok(verdict.ok, verdict.ok ? "" : verdict.error);
  const list = body as LocationsResponse;
  assert.deepEqual(
    list.map((l) => l.name),
    ["east", "west"],
  );
});

test("GET /locations: only GET is allowed, and the request metric uses the route", async () => {
  assert.equal((await fetch(`${base}/locations`, { method: "POST" })).status, 405);
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /route="\/locations",code="200"/);
  assert.match(text, /pulse_api_location_last_result_timestamp_seconds\{location="east"\} 99\n/);
});
