import type { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { ErrorResponse, Incident, MaintenanceWindow, Result } from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { createApiServer } from "./server.ts";
import { createService, type Service } from "./service.ts";

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- local test fixture, never requested
const CHECK = { id: "c1", name: "C1", url: "http://x/", intervalMs: 1000 };

function result(t: number, location: string, status: "up" | "down" = "up"): Result {
  return {
    checkId: "c1",
    timestamp: t,
    status,
    statusCode: null,
    latencyMs: 1,
    reason: null,
    location,
    attempts: 1,
  };
}

async function start(
  opts: {
    maintenance?: MaintenanceWindow[];
    notReady?: () => string | undefined;
    prepare?: (s: Service, db: Database) => void;
  } = {},
) {
  const db = openDb(":memory:");
  const service = createService(db, {
    ...(opts.maintenance === undefined ? {} : { maintenance: opts.maintenance }),
    now: () => 1000,
  });
  service.upsertChecks([CHECK]);
  opts.prepare?.(service, db);
  const server = createApiServer(service, {
    tokens: [],
    now: () => 1000,
    ...(opts.notReady === undefined ? {} : { notReadyReason: opts.notReady }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    service,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function seedIncidents(s: Service, n: number): void {
  // Each pair of 3 downs then an up opens and resolves one incident.
  let t = 1;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) s.ingest(result(t++, "a", "down"));
    s.ingest(result(t++, "a", "up"));
  }
}

test("GET /incidents: 1000 resolved incidents come back without parameters", async () => {
  const { base, close } = await start({
    prepare: (_s, db) => {
      const insert = db.prepare(
        "INSERT INTO incidents (check_id, opened_at, resolved_at, reason) VALUES ('c1', ?, ?, NULL)",
      );
      for (let i = 0; i < 1005; i++) insert.run(i * 10, i * 10 + 5);
    },
  });
  try {
    const all = (await (await fetch(`${base}/incidents?status=resolved`)).json()) as Incident[];
    assert.equal(all.length, 1000);
    assert.equal(all[0]?.openedAt, 1004 * 10); // newest first
    const some = (await (await fetch(`${base}/incidents?limit=3`)).json()) as Incident[];
    assert.equal(some.length, 3);
    const capped = (await (await fetch(`${base}/incidents?limit=999999`)).json()) as Incident[];
    assert.equal(capped.length, 1005); // below the 5000 cap
  } finally {
    await close();
  }
});

test("GET /incidents: since keeps open incidents and those touched at or after it", async () => {
  const { base, close } = await start({ prepare: (s) => seedIncidents(s, 3) });
  try {
    // incidents: opened 3 resolved 4; opened 7 resolved 8; opened 11 resolved 12
    const get = async (q: string): Promise<Incident[]> =>
      (await (await fetch(`${base}/incidents${q}`)).json()) as Incident[];
    assert.equal((await get("?since=0")).length, 3);
    assert.equal((await get("?since=8")).length, 2);
    assert.equal((await get("?since=9")).length, 1);
    assert.equal((await get("?since=13")).length, 0);
  } finally {
    await close();
  }
});

test("GET /incidents: since keeps a still open incident", async () => {
  const { base, close } = await start({
    prepare: (s) => {
      for (const t of [1, 2, 3]) s.ingest(result(t, "a", "down"));
    },
  });
  try {
    const open = (await (await fetch(`${base}/incidents?since=99999`)).json()) as Incident[];
    assert.equal(open.length, 1);
  } finally {
    await close();
  }
});

test("GET /incidents: bad limit and since are 400", async () => {
  const { base, close } = await start();
  try {
    for (const q of ["limit=0", "limit=-1", "limit=x", "limit=1.5", "since=-1", "since=x"]) {
      const res = await fetch(`${base}/incidents?${q}`);
      assert.equal(res.status, 400, q);
      assert.ok(((await res.json()) as ErrorResponse).error.length > 0);
    }
  } finally {
    await close();
  }
});

test("GET /checks/:id/results pages with before and keeps ties together", async () => {
  const { base, close } = await start({
    prepare: (s) => {
      // 5 timestamps, the third one reported by three locations.
      s.ingest(result(10, "a"));
      s.ingest(result(20, "a"));
      for (const l of ["a", "b", "c"]) s.ingest(result(30, l));
      s.ingest(result(40, "a"));
      s.ingest(result(50, "a"));
    },
  });
  try {
    const seen: number[] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const cursor = before === undefined ? "" : `&before=${before}`;
      const q = `limit=2${cursor}`;
      const page = (await (await fetch(`${base}/checks/c1/results?${q}`)).json()) as Result[];
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.timestamp));
      before = page.at(-1)?.timestamp;
    }
    assert.deepEqual(seen, [50, 40, 30, 30, 30, 20, 10]);
    const bad = await fetch(`${base}/checks/c1/results?before=x`);
    assert.equal(bad.status, 400);
    // A page that ends inside the tie returns the whole tie.
    const tie = (await (await fetch(`${base}/checks/c1/results?limit=3`)).json()) as Result[];
    assert.deepEqual(
      tie.map((r) => r.timestamp),
      [50, 40, 30, 30, 30],
    );
  } finally {
    await close();
  }
});

test("GET /maintenance?checkId= answers 404 for an unknown check, otherwise unchanged", async () => {
  const w: MaintenanceWindow = { checkId: "c1", start: 2000, end: 3000, note: "n" };
  const { base, close } = await start({ maintenance: [w] });
  try {
    const res = await fetch(`${base}/maintenance?checkId=nope`);
    assert.equal(res.status, 404);
    assert.deepEqual((await res.json()) as ErrorResponse, { error: 'unknown check "nope"' });
    assert.deepEqual(await (await fetch(`${base}/maintenance?checkId=c1`)).json(), [w]);
    assert.deepEqual(await (await fetch(`${base}/maintenance`)).json(), [w]);
  } finally {
    await close();
  }
});

test("/readyz: 200, 503 while shutting down, 503 without error text when the db fails", async () => {
  let reason: string | undefined;
  const a = await start({ notReady: () => reason });
  try {
    const ok = await fetch(`${a.base}/readyz`);
    assert.equal(ok.status, 200);
    reason = "shutting down";
    const down = await fetch(`${a.base}/readyz`);
    assert.equal(down.status, 503);
    assert.equal(await down.text(), "shutting down\n");
    const health = await fetch(`${a.base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await a.close();
  }
  const db = openDb(":memory:");
  const service = createService(db);
  const server = createApiServer(service, { tokens: [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    db.close();
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(text, "database unavailable\n");
    assert.doesNotMatch(text, /not open/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("cache: an ingest invalidates /checks and /uptime inside the TTL", () => {
  const s = createService(openDb(":memory:"), { now: () => 1000 });
  s.upsertChecks([CHECK]);
  assert.equal(s.listChecks()[0]?.locations.length, 0);
  assert.equal(s.getUptime()[0]?.uptime, null);
  s.ingest(result(900, "a"));
  assert.equal(s.listChecks()[0]?.locations.length, 1);
  assert.equal(s.getUptime()[0]?.uptime, 100);
  // Same inputs without an ingest are served from the cache.
  const first = s.listChecks();
  assert.equal(s.listChecks(), first);
  s.upsertChecks([{ ...CHECK, name: "Renamed" }]);
  assert.equal(s.listChecks()[0]?.name, "Renamed");
});
