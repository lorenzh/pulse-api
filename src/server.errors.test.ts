import { test } from "bun:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";
import type { ErrorResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { ManualRouteError } from "./manual-incident-routes.ts";
import { createApiServer } from "./server.ts";
import { createService } from "./service.ts";

type Admin = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type Call = [string, unknown];

async function startApi(admin: Admin) {
  const calls: Call[] = [];
  const db = openDb(":memory:");
  const service = createService(db, { now: () => 1_000 });
  const server = createApiServer(service, {
    now: () => 1_000,
    admin,
    logError: (message, err) => {
      calls.push([message, err]);
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => {
        db.close();
        r();
      });
      server.closeAllConnections();
    });
  return { calls, port, host: `http://127.0.0.1:${port}`, close };
}

function rawRequest(port: number, request: string, onData?: (text: string) => void) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
      onData?.(text);
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
}

function statusLines(raw: string): number {
  return raw.split("HTTP/1.1 ").length - 1;
}

const nextTurn = () => new Promise<void>((r) => setImmediate(r));

test("a failure after a finished 204 is logged once and the 204 stays bodyless", async () => {
  const boom = new Error("boom");
  let settled: Promise<unknown> = Promise.resolve();
  const api = await startApi((_req, res) => {
    const p = (async () => {
      res.writeHead(204);
      res.end();
      throw boom;
    })();
    settled = p.catch(() => undefined);
    return p;
  });
  try {
    const res = await fetch(`${api.host}/admin/late`);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    await settled;
    await nextTurn();
    assert.deepEqual(api.calls, [["request failed", boom]]);
    assert.equal(api.calls[0]?.[1], boom);
  } finally {
    await api.close();
  }
});

test("a failure after a started 200 is logged once and the response ends unfinished", async () => {
  const boom = new Error("boom");
  let fail: ((err: unknown) => void) | undefined;
  const api = await startApi(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    await new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    return true;
  });
  try {
    let isRejected = false;
    const raw = await rawRequest(
      api.port,
      "GET /admin/partial HTTP/1.1\r\nHost: x\r\n\r\n",
      (t) => {
        if (!isRejected && t.includes("partial")) {
          isRejected = true;
          fail?.(boom);
        }
      },
    );
    assert.equal(statusLines(raw), 1);
    assert.ok(raw.startsWith("HTTP/1.1 200"), raw);
    assert.ok(raw.includes("partial"), raw);
    assert.ok(!raw.includes("internal error"), raw);
    assert.ok(!raw.includes("0\r\n\r\n"), raw);
    assert.deepEqual(api.calls, [["request failed", boom]]);
  } finally {
    await api.close();
  }
});

test("a failure before headers answers a private 500 and is logged once", async () => {
  const boom = new Error("boom secret detail");
  const api = await startApi(() => Promise.reject(boom));
  try {
    const res = await fetch(`${api.host}/admin/early`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text) as ErrorResponse, { error: "internal error" });
    assert.ok(!text.includes("boom secret detail"));
    assert.deepEqual(api.calls, [["request failed", boom]]);
  } finally {
    await api.close();
  }
});

test("expected errors are not logged, before or after headers", async () => {
  let mode: "before" | "after" = "before";
  let fail: ((err: unknown) => void) | undefined;
  const api = await startApi(async (_req, res) => {
    if (mode === "after") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      await new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    }
    throw new ManualRouteError(409, "conflict");
  });
  try {
    const missing = await fetch(`${api.host}/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual((await missing.json()) as ErrorResponse, { error: "not found" });
    const conflict = await fetch(`${api.host}/admin/conflict`);
    assert.equal(conflict.status, 409);
    assert.deepEqual((await conflict.json()) as ErrorResponse, { error: "conflict" });
    mode = "after";
    let isRejected = false;
    const raw = await rawRequest(
      api.port,
      "GET /admin/conflict HTTP/1.1\r\nHost: x\r\n\r\n",
      (t) => {
        if (!isRejected && t.includes("partial")) {
          isRejected = true;
          fail?.(new ManualRouteError(409, "conflict"));
        }
      },
    );
    assert.equal(statusLines(raw), 1);
    assert.ok(raw.startsWith("HTTP/1.1 200"), raw);
    assert.ok(!raw.includes('"error"'), raw);
    assert.deepEqual(api.calls, []);
  } finally {
    await api.close();
  }
});

test("request data stays out of the log and the answer, and the server keeps serving", async () => {
  const boom = new Error("boom");
  const api = await startApi(() => Promise.reject(boom));
  const sentinels = ["auth-sentinel-1", "query-sentinel-2", "body-sentinel-3"];
  try {
    const body = `{"x":"${sentinels[2]}"}`;
    const raw = await rawRequest(
      api.port,
      `POST /admin/fail?q=${sentinels[1]} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${sentinels[0]}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    );
    assert.ok(raw.startsWith("HTTP/1.1 500"), raw);
    assert.ok(raw.includes('{"error":"internal error"}'), raw);
    for (const sentinel of sentinels) {
      assert.ok(!raw.includes(sentinel), sentinel);
      assert.ok(!String(api.calls[0]?.[0]).includes(sentinel), sentinel);
    }
    assert.deepEqual(api.calls, [["request failed", boom]]);
    const health = await fetch(`${api.host}/healthz`);
    assert.equal(health.status, 200);
    await health.text();
    assert.equal(api.calls.length, 1);
  } finally {
    await api.close();
  }
});
