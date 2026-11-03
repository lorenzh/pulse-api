import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import type { ErrorResponse } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService, type Service } from "./service.ts";

type Raw = { status: number; headers: Map<string, string>; body: string };

// fetch normalizes the target, so a malformed one needs a raw socket.
function rawGet(port: number, target: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head = "", body = ""] = data.split("\r\n\r\n");
      const [statusLine = "", ...lines] = head.split("\r\n");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const i = line.indexOf(":");
        headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }
      resolve({ status: Number(statusLine.split(" ")[1]), headers, body });
    });
    socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

const errors: string[] = [];
const server = createApiServer(createService(openDb(":memory:")), {
  now: () => 1000,
  logError: (message) => errors.push(message),
});
let port = 0;

beforeAll(async () => {
  port = await listen(server);
});

afterAll(async () => {
  await close(server);
});

for (const target of ["//[", "//%zz", "//[/healthz"]) {
  test(`GET ${target} answers a quiet 400 invalid request target`, async () => {
    errors.length = 0;
    const res = await rawGet(port, target);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body) as ErrorResponse).toEqual({ error: "invalid request target" });
    expect(res.body).not.toContain(target);
    expect(res.headers.get("content-type") ?? "").toMatch(/^application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // Literal wire version of the pinned contract, not read from the code under test.
    expect(res.headers.get("x-pulse-contract")).toBe("1");
    expect(errors).toEqual([]);
  });
}

test("malformed targets count as unmatched 400 with no 500 sample", async () => {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  expect(text).toMatch(/pulse_api_http_requests_total\{route="unmatched",code="400"\} 3\b/);
  expect(text).not.toContain('code="500"');
});

test("GET /healthz still answers 200", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(res.status).toBe(200);
});

test("another unexpected error still answers 500 and logs once", async () => {
  const service = createService(openDb(":memory:"));
  const throwing: Service = {
    ...service,
    listChecks: () => {
      throw new Error("boom");
    },
  };
  const seen: string[] = [];
  const s = createApiServer(throwing, { now: () => 1000, logError: (m) => seen.push(m) });
  const p = await listen(s);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/checks`);
    expect(res.status).toBe(500);
    expect((await res.json()) as ErrorResponse).toEqual({ error: "internal error" });
    expect(seen).toEqual(["request failed"]);
  } finally {
    await close(s);
  }
});
