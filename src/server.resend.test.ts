import { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NotifyFailedDelivery,
  type NotifyServiceReport,
  type ResendCommand,
  validateResendClaimResponse,
  validateResendCommand,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const ADMIN = "admin-resend-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-11-06T12:00:00Z");
const NOTIFY_ETAG_0 = '"sha256-e60ebcb65ae7f93322e9567f2cf52a1587d1a8ccc4debab9d05e28c8e456ae25"';

let dir = "";
let api: RunningApi;
let base = "";
let clock = NOW;
let notifySecret = "";
let ids = 0;
const lines: string[] = [];

beforeEach(async () => {
  clock = NOW;
  ids = 0;
  lines.length = 0;
  dir = mkdtempSync(join(tmpdir(), "pulse-resend-"));
  const checksFile = join(dir, "checks.json");
  const adminFile = join(dir, "admin.json");
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }],
    }),
  );
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }));
  const tokensFile = join(dir, "tokens.json");
  writeFileSync(
    tokensFile,
    JSON.stringify({ tokens: [{ location: "eu", token: "probe-resend-0123456789abcdef" }] }),
  );
  api = await startApi({
    env: {
      PORT: "0",
      PULSE_DB: join(dir, "pulse.db"),
      PULSE_CHECKS_FILE: checksFile,
      PULSE_API_ADMIN_TOKENS_FILE: adminFile,
      PULSE_TOKENS_FILE: tokensFile,
    },
    now: () => clock,
    sleep: () => new Promise<void>(() => undefined),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    write: (_level, line) => lines.push(line),
    openDb: (path) => openDb(path),
    newResendId: () => {
      ids += 1;
      return `cmd${String(ids).padStart(21, "0")}`;
    },
  });
  base = `http://127.0.0.1:${api.port}`;
  const made = await call("POST", "/admin/tokens", { body: { name: "np", scopes: ["notify"] } });
  assert.equal(made.status, 201);
  notifySecret = ((await made.json()) as { secret: string }).secret;
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CallInit {
  body?: unknown;
  raw?: string;
  token?: string;
}

function call(method: string, path: string, init: CallInit = {}): Promise<Response> {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${init.token ?? ADMIN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

function failed(channelId: string, key: string): NotifyFailedDelivery {
  return { channelId, key, event: "opened", isManual: false, failedAt: NOW, hasPayload: true };
}

async function putReport(list: NotifyFailedDelivery[]): Promise<void> {
  const report: NotifyServiceReport = {
    at: clock,
    startedAt: NOW - 1000,
    appliedRevision: null,
    fileChannels: [],
    fileChannelsTotal: 0,
    shadowedIds: [],
    rejected: [],
    failed: list,
    failedTotal: list.length,
  };
  const r = await call("PUT", "/service/notify/report", { body: report, token: notifySecret });
  assert.equal(r.status, 204);
}

const RID_A = "request-a-0000000001";
const RID_B = "request-b-0000000002";
const RID_C = "request-c-0000000003";

function resend(requestId: string, key = "42:opened", channelId = "a"): Promise<Response> {
  return call("POST", "/admin/notify/resends", { body: { channelId, key, requestId } });
}

async function command(r: Response): Promise<ResendCommand> {
  const v = validateResendCommand(await r.json());
  if (!v.ok) throw new Error(v.error);
  return v.value;
}

async function errorOf(r: Response): Promise<string> {
  return ((await r.json()) as { error: string }).error;
}

async function claim(): Promise<ResendCommand[]> {
  const r = await call("POST", "/service/notify/resends/claim", { token: notifySecret });
  assert.equal(r.status, 200);
  const v = validateResendClaimResponse(await r.json());
  if (!v.ok) throw new Error(v.error);
  return v.value.commands;
}

function postResult(id: string, state: string): Promise<Response> {
  return call("POST", `/service/notify/resends/${id}/result`, {
    body: { state },
    token: notifySecret,
  });
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(join(dir, "pulse.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function count(table: string): number {
  return withDb(
    (db) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1,
  );
}

function resendAudits(): number {
  return withDb(
    (db) =>
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'notify-resend.create'",
        )
        .get()?.n ?? -1,
  );
}

function allAudits(): number {
  return withDb(
    (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n ?? -1,
  );
}

function setState(id: string, state: string): void {
  withDb((db) => db.run("UPDATE resend_commands SET state = ? WHERE id = ?", [state, id]));
}

function stateOf(id: string): string {
  return withDb(
    (db) =>
      db
        .query<{ state: string }, [string]>("SELECT state FROM resend_commands WHERE id = ?")
        .get(id)?.state ?? "missing",
  );
}

/** Fill resend_commands up to `n` rows with the given state and updatedAt values. */
function fillCommands(n: number, finished: number[] = []): void {
  withDb((db) =>
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const updated = finished[i];
        db.run(
          `INSERT INTO resend_commands (id, request_id, channel_id, key, state, created_at, updated_at)
           VALUES (?, ?, 'f', ?, ?, ?, ?)`,
          [
            `fill${String(i).padStart(20, "0")}`,
            `fillrequest${String(i).padStart(10, "0")}`,
            `k${i}`,
            updated === undefined ? "queued" : "delivered",
            NOW,
            updated ?? NOW,
          ],
        );
      }
    })(),
  );
}

test("the same requestId gives 202 then 200 with one command and one audit row", async () => {
  await putReport([failed("a", "42:opened")]);
  const first = await resend(RID_A);
  assert.equal(first.status, 202);
  const c = await command(first);
  assert.equal(c.id, "cmd000000000000000000001");
  assert.equal(c.state, "queued");
  const again = await resend(RID_A);
  assert.equal(again.status, 200);
  assert.equal((await command(again)).id, "cmd000000000000000000001");
  assert.equal(count("resend_commands"), 1);
  assert.equal(count("resend_requests"), 1);
  assert.equal(resendAudits(), 1);
  const other = await resend(RID_A, "43:opened");
  assert.equal(other.status, 409);
  assert.equal(await errorOf(other), "requestId was used for another delivery");
  const read = await call("GET", "/admin/notify/resends/cmd000000000000000000001");
  assert.equal(read.status, 200);
  assert.equal((await command(read)).requestId, RID_A);
  assert.equal((await call("GET", "/admin/notify/resends/unknown")).status, 404);
});

for (const state of ["queued", "claimed", "admitted"]) {
  test(`a second requestId reuses a ${state} command and stores both ids`, async () => {
    await putReport([failed("a", "42:opened")]);
    assert.equal((await resend(RID_A)).status, 202);
    setState("cmd000000000000000000001", state);
    const second = await resend(RID_B);
    assert.equal(second.status, 200);
    assert.equal((await command(second)).id, "cmd000000000000000000001");
    assert.equal(count("resend_commands"), 1);
    assert.equal(count("resend_requests"), 2);
    assert.equal(resendAudits(), 1);
  });
}

test("a lost 200 after reuse repeats the same failed command on retry", async () => {
  await putReport([failed("a", "42:opened")]);
  assert.equal((await resend(RID_A)).status, 202);
  assert.equal((await resend(RID_B)).status, 200);
  const [claimed] = await claim();
  assert.equal(claimed?.id, "cmd000000000000000000001");
  assert.equal((await postResult("cmd000000000000000000001", "admitted")).status, 204);
  assert.equal((await postResult("cmd000000000000000000001", "failed")).status, 204);
  await putReport([failed("a", "42:opened")]);
  const retry = await resend(RID_B);
  assert.equal(retry.status, 200);
  const c = await command(retry);
  assert.equal(c.id, "cmd000000000000000000001");
  assert.equal(c.state, "failed");
  assert.equal(count("resend_commands"), 1);
  assert.deepEqual(await claim(), []);
});

test("a request whose command was deleted is 409 and makes no command", async () => {
  await putReport([failed("a", "42:opened")]);
  assert.equal((await resend(RID_A)).status, 202);
  withDb((db) => db.run("DELETE FROM resend_commands"));
  const r = await resend(RID_A);
  assert.equal(r.status, 409);
  assert.equal(await errorOf(r), "the resend request was already handled; reload the failed list");
  assert.equal(count("resend_commands"), 0);
});

test("a new request needs a fresh report that lists the delivery as failed", async () => {
  const never = await resend(RID_A);
  assert.equal(never.status, 503);
  assert.equal(await errorOf(never), "pulse-notify has not reported recently");
  await putReport([failed("a", "42:opened")]);
  clock = NOW + 180_001;
  assert.equal((await resend(RID_A)).status, 503);
  clock = NOW + 180_000;
  const missing = await resend(RID_B, "99:opened");
  assert.equal(missing.status, 409);
  assert.equal(await errorOf(missing), "not a failed delivery");
  assert.equal(count("resend_requests"), 0);
  assert.equal((await resend(RID_A)).status, 202);
});

test("10000 request rows give 503 also on reuse, and a stored request still repeats", async () => {
  await putReport([failed("a", "42:opened"), failed("a", "43:opened")]);
  assert.equal((await resend(RID_A)).status, 202);
  withDb((db) =>
    db.transaction(() => {
      for (let i = 1; i < 10_000; i++) {
        db.run(
          "INSERT INTO resend_requests (request_id, command_id, channel_id, key, created_at) VALUES (?, 'x', 'f', 'k', ?)",
          [`fillrequest${String(i).padStart(10, "0")}`, NOW],
        );
      }
    })(),
  );
  for (const r of [await resend(RID_B), await resend(RID_C, "43:opened")]) {
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "60");
    assert.equal(await errorOf(r), "too many resend requests");
  }
  assert.equal(count("resend_requests"), 10_000);
  assert.equal(count("resend_commands"), 1);
  assert.equal((await resend(RID_A)).status, 200);
});

test("1000 open commands give 503 and store nothing", async () => {
  await putReport([failed("a", "42:opened")]);
  fillCommands(1000);
  const r = await resend(RID_A);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(await errorOf(r), "too many open resend commands");
  assert.equal(count("resend_commands"), 1000);
  assert.equal(count("resend_requests"), 0);
  assert.equal(resendAudits(), 0);
});

test("1000 commands evict exactly the oldest finished one, id breaking ties", async () => {
  await putReport([failed("a", "42:opened"), failed("a", "43:opened")]);
  // Rows 0..2 are finished at 30, 10, 20; row 3 is finished at 10 too but has a larger id.
  fillCommands(1000, [30, 10, 20, 10]);
  assert.equal((await resend(RID_A)).status, 202);
  assert.equal(count("resend_commands"), 1000);
  assert.equal(stateOf("fill00000000000000000001"), "missing");
  assert.equal(stateOf("fill00000000000000000003"), "delivered");
  assert.equal((await resend(RID_B, "43:opened")).status, 202);
  assert.equal(stateOf("fill00000000000000000003"), "missing");
  assert.equal(stateOf("fill00000000000000000002"), "delivered");
  assert.equal(stateOf("fill00000000000000000000"), "delivered");
  assert.equal(count("resend_commands"), 1000);
});

test("claim takes at most 20 oldest, requeues at 60000 ms and never admitted", async () => {
  const keys = Array.from({ length: 22 }, (_, i) => `${i}:opened`);
  await putReport(keys.map((k) => failed("a", k)));
  for (const [i, k] of keys.entries()) {
    clock = NOW + i;
    assert.equal((await resend(`request-${String(i).padStart(12, "0")}`, k)).status, 202);
  }
  clock = NOW + 100;
  const first = await claim();
  assert.equal(first.length, 20);
  assert.equal(first[0]?.id, "cmd000000000000000000001");
  assert.equal(first[19]?.id, "cmd000000000000000000020");
  assert.ok(first.every((c) => c.state === "claimed"));
  setState("cmd000000000000000000001", "admitted");
  clock = NOW + 100 + 59_999;
  assert.deepEqual(
    (await claim()).map((c) => c.id),
    ["cmd000000000000000000021", "cmd000000000000000000022"],
  );
  clock = NOW + 100 + 60_000;
  const again = await claim();
  assert.equal(again.length, 19);
  assert.equal(again[0]?.id, "cmd000000000000000000002");
  assert.equal(stateOf("cmd000000000000000000001"), "admitted");
});

const ALL = [
  "admitted",
  "delivered",
  "failed",
  "dropped",
  "not-failed",
  "no-payload",
  "channel-unavailable",
];

/** Decision 14: stored state → posted states answered 204, with the state stored after them. */
const ACCEPTED: Record<string, Record<string, string>> = {
  queued: {
    admitted: "admitted",
    delivered: "delivered",
    failed: "failed",
    dropped: "dropped",
    "not-failed": "not-failed",
    "no-payload": "no-payload",
    "channel-unavailable": "channel-unavailable",
  },
  claimed: {
    admitted: "admitted",
    delivered: "delivered",
    failed: "failed",
    dropped: "dropped",
    "not-failed": "not-failed",
    "no-payload": "no-payload",
    "channel-unavailable": "channel-unavailable",
  },
  admitted: {
    admitted: "admitted",
    delivered: "delivered",
    failed: "failed",
    dropped: "dropped",
  },
  delivered: { delivered: "delivered", admitted: "delivered" },
  failed: { failed: "failed", admitted: "failed" },
  dropped: { dropped: "dropped", admitted: "dropped" },
  "not-failed": { "not-failed": "not-failed" },
  "no-payload": { "no-payload": "no-payload" },
  "channel-unavailable": { "channel-unavailable": "channel-unavailable" },
};

test("every result pair answers 204 or 409 as Decision 14 says", async () => {
  await putReport([failed("a", "42:opened")]);
  assert.equal((await resend(RID_A)).status, 202);
  const id = "cmd000000000000000000001";
  for (const [stored, accepted] of Object.entries(ACCEPTED)) {
    for (const posted of ALL) {
      setState(id, stored);
      const r = await postResult(id, posted);
      const after = accepted[posted];
      if (after === undefined) {
        assert.equal(r.status, 409, `${stored} <- ${posted}`);
        assert.equal(await errorOf(r), `result ${posted} does not follow ${stored}`);
        assert.equal(stateOf(id), stored);
      } else {
        assert.equal(r.status, 204, `${stored} <- ${posted}`);
        assert.equal(stateOf(id), after, `${stored} <- ${posted}`);
      }
    }
  }
  assert.equal((await postResult("cmd000000000000000009999", "delivered")).status, 404);
  for (const bad of ["queued", "claimed", "warning"]) {
    assert.equal((await postResult(id, bad)).status, 422);
  }
  assert.ok(lines.some((l) => l.includes(id) && l.includes("service resend result")));
});

test("claims, results and repeats bump no revision and write no audit row", async () => {
  await putReport([failed("a", "42:opened")]);
  const before = (await call("GET", "/admin/notify/channels")).headers.get("etag");
  assert.equal(before, NOTIFY_ETAG_0);
  const audits = allAudits();
  assert.equal((await resend(RID_A)).status, 202);
  for (let i = 0; i < 100; i++) {
    await claim();
    await putReport([failed("a", "42:opened")]);
  }
  for (let i = 0; i < 200; i++) assert.equal((await resend(RID_A)).status, 200);
  assert.equal((await postResult("cmd000000000000000000001", "admitted")).status, 204);
  assert.equal(resendAudits(), 1);
  assert.equal(allAudits(), audits + 1);
  assert.equal((await call("GET", "/admin/notify/channels")).headers.get("etag"), NOTIFY_ETAG_0);
});

test("metric labels are the literal resend route patterns", async () => {
  await resend(RID_A);
  await call("GET", "/admin/notify/resends/abc");
  await claim();
  await postResult("abc", "delivered");
  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const route of [
    "/admin/notify/resends",
    "/admin/notify/resends/:id",
    "/service/notify/resends/claim",
    "/service/notify/resends/:id/result",
  ]) {
    assert.match(metrics, new RegExp(`pulse_api_http_requests_total\\{route="${route}"`), route);
  }
  assert.doesNotMatch(metrics, /route="\/admin\/notify\/resends\/abc"/);
  assert.doesNotMatch(metrics, /route="\/service\/notify\/resends\/abc\/result"/);
});
