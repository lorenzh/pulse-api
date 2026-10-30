import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ErrorResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

const server = createApiServer(createService(openDb(":memory:")), {
  tokens: [{ location: "default", token: "ops-token-0123456789abcdef" }],
  now: () => 1000,
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
});

for (const path of ["/healthz", "/readyz", "/metrics"]) {
  for (const suffix of ["", "?x=1"]) {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      test(`${method} ${path}${suffix} answers a JSON 405 with Allow: GET`, async () => {
        const res = await fetch(`${base}${path}${suffix}`, { method });
        assert.equal(res.status, 405);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.equal(res.headers.get("allow"), "GET");
        if (method !== "HEAD") {
          const body = (await res.json()) as ErrorResponse;
          assert.deepEqual(body, { error: "method not allowed" });
        }
      });
    }
  }
  test(`GET ${path} still answers 200`, async () => {
    const res = await fetch(`${base}${path}?x=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  });
}
