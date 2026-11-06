import { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminNotifyChannelsView,
  type AdminNotifyFailedView,
  type NotifyChannelRecord,
  type NotifyServiceReport,
  validateAdminNotifyChannelsView,
  validateAdminNotifyFailedView,
  validateNotifyChannelRecord,
  validateServiceNotifyChannels,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const ADMIN = "admin-notify-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-11-06T12:00:00Z");
const SENTINEL = "PULSE_NOTIFY_SECRET_SENTINEL";

let dir = "";
let api: RunningApi;
let base = "";
let clock = NOW;
let notifySecret = "";
let statusSecret = "";
const lines: string[] = [];

beforeEach(async () => {
  clock = NOW;
  lines.length = 0;
  dir = mkdtempSync(join(tmpdir(), "pulse-notify-channels-"));
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
    JSON.stringify({ tokens: [{ location: "eu", token: "probe-notify-0123456789abcdef" }] }),
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
  });
  base = `http://127.0.0.1:${api.port}`;
  notifySecret = await makeToken("np", "notify");
  statusSecret = await makeToken("sp", "status");
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

async function makeToken(name: string, scope: string): Promise<string> {
  const made = await call("POST", "/admin/tokens", { body: { name, scopes: [scope] } });
  assert.equal(made.status, 201);
  return ((await made.json()) as { secret: string }).secret;
}

interface CallInit {
  body?: unknown;
  raw?: string;
  token?: string;
  headers?: Record<string, string>;
}

function call(method: string, path: string, init: CallInit = {}): Promise<Response> {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${init.token ?? ADMIN}`,
      "content-type": "application/json",
      ...init.headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function adminView(): Promise<{ view: AdminNotifyChannelsView; etag: string }> {
  const r = await call("GET", "/admin/notify/channels");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const v = validateAdminNotifyChannelsView(await r.json());
  if (!v.ok) throw new Error(v.error);
  const etag = r.headers.get("etag");
  assert.ok(etag);
  return { view: v.value, etag };
}

/** Reads the service answer and checks it as R1 says: the envelope, then every record. */
async function serviceChannels(): Promise<{ channels: NotifyChannelRecord[]; size: number }> {
  const r = await call("GET", "/service/notify/channels", { token: notifySecret });
  assert.equal(r.status, 200);
  const text = await r.text();
  const body: unknown = JSON.parse(text);
  const envelope = validateServiceNotifyChannels(body);
  if (!envelope.ok) throw new Error(envelope.error);
  const channels = envelope.value.channels.map((c, i) => {
    const record = validateNotifyChannelRecord(c, `channels[${i}]`);
    if (!record.ok) throw new Error(record.error);
    return record.value;
  });
  return { channels, size: Buffer.byteLength(text) };
}

/** Every channel in a write answer must be a valid record too. */
async function checkedWrite(r: Response): Promise<AdminNotifyChannelsView> {
  const v = validateAdminNotifyChannelsView(await r.json());
  if (!v.ok) throw new Error(v.error);
  for (const c of [...v.value.channels, ...v.value.shadowed]) {
    const record = Object.fromEntries(Object.entries(c).filter(([k]) => k !== "source"));
    const ok = validateNotifyChannelRecord(record);
    if (!ok.ok) throw new Error(ok.error);
  }
  return v.value;
}

async function etagNow(): Promise<string> {
  return (await adminView()).etag;
}

function webhook(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: "webhook", urlEnv: "PULSE_NOTIFY_SECRET_HOOK", ...extra };
}

/** A webhook of exactly `target` UTF-8 JSON bytes, padded with `checks` entries (<= 200 chars). */
function sized(id: string, target: number): Record<string, unknown> {
  const checks: string[] = [];
  const def = webhook(id, { checks });
  while (target - bytes(def) > 406) checks.push("k".repeat(200));
  const rest = target - bytes(def) - (checks.length === 0 ? 5 : 6);
  const a = Math.floor(rest / 2);
  checks.push("a".repeat(a), "b".repeat(rest - a));
  assert.equal(bytes(def), target);
  return def;
}

async function create(def: unknown, etag: string): Promise<Response> {
  return call("POST", "/admin/notify/channels", { body: def, headers: { "if-match": etag } });
}

async function createOk(def: unknown, etag: string): Promise<string> {
  const r = await create(def, etag);
  assert.equal(r.status, 201, await r.clone().text());
  await checkedWrite(r);
  return r.headers.get("etag") ?? "";
}

function putChannel(id: string, def: unknown, etag: string | undefined): Promise<Response> {
  return call("PUT", `/admin/notify/channels/${id}`, {
    body: def,
    headers: etag === undefined ? {} : { "if-match": etag },
  });
}

function report(extra: Partial<NotifyServiceReport> = {}): NotifyServiceReport {
  return {
    at: NOW,
    startedAt: NOW - 1000,
    appliedRevision: null,
    fileChannels: [],
    fileChannelsTotal: 0,
    shadowedIds: [],
    rejected: [],
    failed: [],
    failedTotal: 0,
    ...extra,
  };
}

function putReport(raw: string): Promise<Response> {
  return call("PUT", "/service/notify/report", { raw, token: notifySecret });
}

function auditRows(): { action: string; target_kind: string; target_id: string }[] {
  const db = new Database(join(dir, "pulse.db"), { readonly: true });
  try {
    return db.query("SELECT * FROM audit_log ORDER BY id").all() as {
      action: string;
      target_kind: string;
      target_id: string;
    }[];
  } finally {
    db.close();
  }
}

function rawStatus(method: string, path: string, body: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    // The server may answer 413 and close before the whole body is sent.
    req.on("error", reject);
    req.end(body);
  });
}

test("never without a report: shadowed [], no-store, an etag, and never 304", async () => {
  const { view, etag } = await adminView();
  assert.deepEqual(view, {
    revision: "sha256-e60ebcb65ae7f93322e9567f2cf52a1587d1a8ccc4debab9d05e28c8e456ae25",
    channels: [],
    shadowed: [],
    service: { state: "never", receivedAt: null, report: null },
  });
  const again = await call("GET", "/admin/notify/channels", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 200);
  const failed = await call("GET", "/admin/notify/failed");
  assert.equal(failed.status, 200);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failed.json(), {
    state: "never",
    receivedAt: null,
    failed: [],
    failedTotal: 0,
  });
});

test("create 201 with location, replace 200, delete 204, with audit rows and no values", async () => {
  let etag = await etagNow();
  const made = await create(webhook("ops", { checks: ["api*"], secretEnv: SENTINEL }), etag);
  assert.equal(made.status, 201);
  assert.equal(made.headers.get("location"), "/admin/notify/channels/ops");
  const view = await checkedWrite(made);
  assert.deepEqual(
    view.channels.map((c) => [c.id, c.source, c.createdAt, c.updatedAt]),
    [["ops", "database", NOW, NOW]],
  );
  etag = made.headers.get("etag") ?? "";
  assert.equal(etag, '"sha256-d7e079324dde384a8c0f28bc4d196b05cd88a9f7414ceefaa5f3ca69c0ced106"');
  clock = NOW + 5;
  const replaced = await putChannel("ops", webhook("ops", { checks: ["b"] }), etag);
  assert.equal(replaced.status, 200);
  const after = await checkedWrite(replaced);
  assert.deepEqual(after.channels[0]?.checks, ["b"]);
  assert.equal(after.channels[0]?.createdAt, NOW);
  assert.equal(after.channels[0]?.updatedAt, NOW + 5);
  etag = replaced.headers.get("etag") ?? "";
  const deleted = await call("DELETE", "/admin/notify/channels/ops", {
    headers: { "if-match": etag },
  });
  assert.equal(deleted.status, 204);
  assert.equal(
    deleted.headers.get("etag"),
    '"sha256-48d4da57d59b83aa78309cec3c97b03bd8afb56dea3e06a78efcdc60259acd65"',
  );
  assert.equal(deleted.headers.get("etag"), await etagNow());
  assert.deepEqual((await adminView()).view.channels, []);
  const rows = auditRows().filter((r) => r.target_kind === "notify-channel");
  assert.deepEqual(
    rows.map((r) => [r.action, r.target_id]),
    [
      ["notify-channel.create", "ops"],
      ["notify-channel.replace", "ops"],
      ["notify-channel.delete", "ops"],
    ],
  );
  assert.ok(auditRows().every((r) => !JSON.stringify(r).includes(SENTINEL)));
  assert.ok(lines.every((l) => !l.includes(SENTINEL)));
});

test("If-Match: missing 428, malformed 400, stale 412 on create, replace and delete", async () => {
  const old = await etagNow();
  const etag = await createOk(webhook("ops"), old);
  const def = webhook("x");
  assert.equal((await create(def, '"nope"')).status, 400);
  assert.equal((await call("POST", "/admin/notify/channels", { body: def })).status, 428);
  const stale = await create(def, old);
  assert.equal(stale.status, 412);
  assert.deepEqual(await stale.json(), { error: "the settings changed: reload them and retry" });
  assert.equal((await putChannel("ops", webhook("ops"), undefined)).status, 428);
  assert.equal((await putChannel("ops", webhook("ops"), old)).status, 412);
  assert.equal((await call("DELETE", "/admin/notify/channels/ops")).status, 428);
  const del = await call("DELETE", "/admin/notify/channels/ops", { headers: { "if-match": old } });
  assert.equal(del.status, 412);
  const gone = await call("DELETE", "/admin/notify/channels/nope", {
    headers: { "if-match": etag },
  });
  assert.equal(gone.status, 404);
});

test("400 body id differs from the path, 404 unknown and file-only ids", async () => {
  let etag = await etagNow();
  etag = await createOk(webhook("ops"), etag);
  assert.equal((await putReport(JSON.stringify(fileReport(["file-only"])))).status, 204);
  assert.equal((await putChannel("ops", webhook("other"), etag)).status, 400);
  assert.equal((await putChannel("nope", webhook("nope"), etag)).status, 404);
  assert.equal((await putChannel("file-only", webhook("file-only"), etag)).status, 404);
});

function fileReport(ids: string[], extra: Partial<NotifyServiceReport> = {}): NotifyServiceReport {
  return report({
    fileChannels: ids.map((id) => ({ source: "file", id, type: "slack", refs: ["SLACK_OPS"] })),
    fileChannelsTotal: ids.length,
    ...extra,
  });
}

test("invalid writes give 422 and leave storage, revision and audit unchanged", async () => {
  let etag = await etagNow();
  etag = await createOk(webhook("ops"), etag);
  const audits = auditRows().length;
  const before = await serviceChannels();
  const invalid: unknown[] = [
    webhook("bad", { urlEnv: "SLACK_OPS" }),
    webhook("bad", { secretFile: "../etc/passwd" }),
    { id: "bad", type: "webhook", url: "https://x.example/" },
    { id: "bad", type: "file", path: "x.log" },
    webhook("Ops"),
    sized("big", 16_385),
  ];
  for (const def of invalid) {
    assert.equal((await create(def, etag)).status, 422, JSON.stringify(def).slice(0, 80));
  }
  const literal = await create({ id: "bad", type: "webhook", url: "https://x.example/" }, etag);
  assert.match(((await literal.json()) as { error: string }).error, /unknown field: url/);
  assert.equal((await putChannel("ops", webhook("ops", { urlEnv: "X" }), etag)).status, 422);
  assert.equal((await putChannel("ops", sized("ops", 16_385), etag)).status, 422);
  assert.equal(await etagNow(), etag);
  assert.equal(auditRows().length, audits);
  assert.deepEqual(await serviceChannels(), before);
});

test("one definition of 16384 bytes is accepted, 16385 and four 200x200 lists are 422", async () => {
  const etag = await createOk(sized("max", 16_384), await etagNow());
  const over = await create(sized("over", 16_385), etag);
  assert.equal(over.status, 422);
  assert.deepEqual(await over.json(), { error: "channel: must be at most 16384 bytes as JSON" });
  const list = Array.from({ length: 200 }, () => "l".repeat(200));
  const four = webhook("four", {
    checks: list,
    excludeChecks: list,
    components: list,
    excludeComponents: list,
  });
  assert.equal((await create(four, etag)).status, 422);
});

test("aggregate: 262144 bytes accepted, 262145 and the 101st channel 422, replace substitutes", async () => {
  let etag = await etagNow();
  for (let i = 0; i < 15; i += 1) etag = await createOk(sized(`c${i}`, 16_384), etag);
  etag = await createOk(sized("c15", 16_000), etag);
  // 15 x 16384 + 16000 = 261760; 385 more is 262145 bytes.
  const over = await create(sized("c16", 385), etag);
  assert.equal(over.status, 422);
  assert.deepEqual(await over.json(), {
    error: "channels: must be at most 262144 bytes as JSON in total",
  });
  etag = await createOk(sized("c16", 384), etag);
  // The total is 262144 now: a replace of the same size is 200, one byte more is 422.
  const same = await putChannel("c16", sized("c16", 384), etag);
  assert.equal(same.status, 200);
  await checkedWrite(same);
  etag = same.headers.get("etag") ?? "";
  assert.equal((await putChannel("c16", sized("c16", 385), etag)).status, 422);
  const service = await serviceChannels();
  assert.equal(service.channels.length, 17);
  assert.ok(service.size <= 274_344, String(service.size));
});

test("the 101st channel is 422", async () => {
  let etag = await etagNow();
  for (let i = 0; i < 100; i += 1) etag = await createOk(webhook(`n${i}`), etag);
  const r = await create(webhook("n100"), etag);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: "channels: must hold at most 100 channels" });
  assert.equal((await serviceChannels()).channels.length, 100);
});

test("collisions: file id 409, overflow file id created then shadowed, shadowed PUT 409", async () => {
  let etag = await etagNow();
  const listed = Array.from({ length: 200 }, (_, i) => `f${i}`);
  const first = fileReport(["ops", ...listed.slice(1)], { fileChannelsTotal: 201 });
  assert.equal((await putReport(JSON.stringify(first))).status, 204);
  assert.equal((await create(webhook("ops"), etag)).status, 409);
  // `hidden` is beyond the 200 listed file ids: the api cannot see it.
  etag = await createOk(webhook("hidden"), etag);
  assert.equal((await create(webhook("hidden"), etag)).status, 409);
  const second = { ...first, shadowedIds: ["hidden"] };
  assert.equal((await putReport(JSON.stringify(second))).status, 204);
  // A stale report still decides the shadowed list.
  clock = NOW + 180_001;
  const { view } = await adminView();
  assert.equal(view.service.state, "stale");
  assert.deepEqual(
    view.shadowed.map((c) => c.id),
    ["hidden"],
  );
  assert.deepEqual(view.channels, []);
  const put = await putChannel("hidden", webhook("hidden"), etag);
  assert.equal(put.status, 409);
  const del = await call("DELETE", "/admin/notify/channels/hidden", {
    headers: { "if-match": etag },
  });
  assert.equal(del.status, 204);
});

test("service GET: etag, 304 on a match, every record valid", async () => {
  const etag = await createOk(webhook("ops", { checks: ["c0"] }), await etagNow());
  const r = await call("GET", "/service/notify/channels", { token: notifySecret });
  assert.equal(r.headers.get("etag"), etag);
  const { channels } = await serviceChannels();
  assert.deepEqual(channels, [
    {
      id: "ops",
      type: "webhook",
      urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
      checks: ["c0"],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  const cached = await call("GET", "/service/notify/channels", {
    token: notifySecret,
    headers: { "if-none-match": etag },
  });
  assert.equal(cached.status, 304);
});

test("100 reports change neither the notify etag nor the audit; admin GET stays 200", async () => {
  const etag = await createOk(webhook("ops"), await etagNow());
  const audits = auditRows().length;
  for (let i = 0; i < 100; i += 1) {
    assert.equal((await putReport(JSON.stringify(report({ at: NOW + i })))).status, 204);
  }
  const r = await call("GET", "/admin/notify/channels", { headers: { "if-none-match": etag } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("etag"), etag);
  const view = (await r.json()) as AdminNotifyChannelsView;
  assert.equal(view.service.report?.at, NOW + 99);
  const service = await call("GET", "/service/notify/channels", {
    token: notifySecret,
    headers: { "if-none-match": etag },
  });
  assert.equal(service.status, 304);
  assert.equal(auditRows().length, audits);
  assert.equal((await putChannel("ops", webhook("ops"), etag)).status, 200);
});

test("channel, status and check saves do not stale one another", async () => {
  const channelTag = await etagNow();
  const statusView = await call("GET", "/admin/status/settings");
  const statusTag = statusView.headers.get("etag") ?? "";
  const config = await call("GET", "/admin/config");
  const checkTag = config.headers.get("etag") ?? "";
  const status = await call("PUT", "/admin/status/settings", {
    body: { name: "Acme" },
    headers: { "if-match": statusTag },
  });
  assert.equal(status.status, 200);
  const check = await call("POST", "/admin/checks", {
    body: { id: "b", name: "B", url: "https://b.example/", intervalMs: 60000 },
    headers: { "if-match": checkTag },
  });
  assert.equal(check.status, 201);
  const channel = await create(webhook("ops"), channelTag);
  assert.equal(channel.status, 201);
  const nextStatus = await call("PUT", "/admin/status/settings", {
    body: { name: "Acme 2" },
    headers: { "if-match": status.headers.get("etag") ?? "" },
  });
  assert.equal(nextStatus.status, 200);
  const nextCheck = await call("PUT", "/admin/checks/b", {
    body: { id: "b", name: "B2", url: "https://b.example/", intervalMs: 60000 },
    headers: { "if-match": check.headers.get("etag") ?? "" },
  });
  assert.equal(nextCheck.status, 200);
});

test("report state: fresh at 180000 ms, stale at 180001 ms with the report kept", async () => {
  const stored = report({ shadowedIds: ["ops"] });
  assert.equal((await putReport(JSON.stringify(stored))).status, 204);
  clock = NOW + 180_000;
  assert.equal((await adminView()).view.service.state, "fresh");
  clock = NOW + 180_001;
  const { view } = await adminView();
  assert.equal(view.service.state, "stale");
  assert.equal(view.service.receivedAt, NOW);
  assert.deepEqual(view.service.report, stored);
});

const FAILED = [
  {
    channelId: "ops",
    key: "manual:x:update:abc",
    event: "update",
    isManual: true,
    failedAt: NOW - 10,
    hasPayload: true,
  },
  {
    channelId: "ops",
    key: "legacy",
    event: "unknown",
    isManual: false,
    failedAt: NOW - 20,
    hasPayload: false,
  },
] as const;

test("failed view: only state, receive time, failed and totals; events round-trip", async () => {
  const stored = fileReport(["file-a"], {
    failed: [...FAILED],
    failedTotal: 5,
    rejected: [{ channelId: null, reason: "bad answer" }],
  });
  assert.equal((await putReport(JSON.stringify(stored))).status, 204);
  const r = await call("GET", "/admin/notify/failed");
  const body: unknown = await r.json();
  const v = validateAdminNotifyFailedView(body);
  if (!v.ok) throw new Error(v.error);
  const expected: AdminNotifyFailedView = {
    state: "fresh",
    receivedAt: NOW,
    failed: [...FAILED],
    failedTotal: 5,
  };
  assert.deepEqual(body, expected);
  assert.deepEqual((await adminView()).view.service.report?.failed, [...FAILED]);
  const warning = { ...FAILED[0], event: "warning" };
  assert.equal(
    (await putReport(JSON.stringify({ ...report(), failed: [warning], failedTotal: 1 }))).status,
    422,
  );
  const noManual = Object.fromEntries(Object.entries(FAILED[0]).filter(([k]) => k !== "isManual"));
  assert.equal(
    (await putReport(JSON.stringify({ ...report(), failed: [noManual], failedTotal: 1 }))).status,
    422,
  );
  assert.deepEqual((await adminView()).view.service.report, stored);
});

/** A report of exactly 524 288 bytes: 200 file views, 200 failed entries, 100 rejected. */
function largestReport(shadowedIds: string[]): NotifyServiceReport {
  const fileChannels = Array.from({ length: 200 }, (_, i) => ({
    source: "file" as const,
    id: `FILE-VIEW-${String(i).padStart(3, "0")}-${"i".repeat(186)}`,
    type: "webhook" as const,
    refs: Array.from({ length: 6 }, () => "r".repeat(200)),
  }));
  const failed = Array.from({ length: 200 }, (_, i) => ({
    channelId: `ch${i}`.padEnd(200, "c"),
    key: `${i}:opened`.padEnd(300, "k"),
    event: "domain-expiry" as const,
    isManual: false,
    failedAt: NOW,
    hasPayload: true,
  }));
  const rejected = Array.from({ length: 100 }, (_, i) => ({
    channelId: `rj${i}`.padEnd(200, "j"),
    reason: "x".repeat(300),
  }));
  const r = report({
    fileChannels,
    fileChannelsTotal: 200,
    shadowedIds,
    failed,
    failedTotal: 200,
    rejected,
  });
  // Fill the rest with quotes in the refs: each is 2 bytes as JSON instead of 1.
  let missing = SERVICE_REPORT_BYTES - bytes(r);
  for (const view of fileChannels) {
    view.refs = view.refs.map((ref) => {
      const n = Math.min(missing, ref.length);
      missing -= n;
      return '"'.repeat(n) + ref.slice(n);
    });
  }
  assert.equal(bytes(r), SERVICE_REPORT_BYTES);
  return r;
}

const SERVICE_REPORT_BYTES = 524_288;

test("sizes: 524288-byte report 204, 524289 413 kept; admin view within 798932 bytes", async () => {
  let etag = await etagNow();
  for (let i = 0; i < 16; i += 1) etag = await createOk(sized(`c${i}`, 16_384), etag);
  const stored = largestReport(["c0", "c1"]);
  const text = JSON.stringify(stored);
  assert.equal(await rawStatus("PUT", "/service/notify/report", text, notifySecret), 204);
  assert.equal(await rawStatus("PUT", "/service/notify/report", `${text} `, notifySecret), 413);
  const r = await call("GET", "/admin/notify/channels");
  const raw = await r.text();
  assert.ok(Buffer.byteLength(raw) <= 798_932, String(Buffer.byteLength(raw)));
  assert.equal(raw.split("FILE-VIEW-000-").length - 1, 1);
  const view = JSON.parse(raw) as AdminNotifyChannelsView;
  assert.deepEqual(view.service.report, stored);
  const ids = [...view.channels, ...view.shadowed]
    .map((c) => c.id)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    ids,
    Array.from({ length: 16 }, (_, i) => `c${i}`).sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    view.shadowed.map((c) => c.id),
    ["c0", "c1"],
  );
  const service = await serviceChannels();
  assert.equal(service.channels.length, 16);
  assert.ok(service.size <= 274_344, String(service.size));
});

test("a service token of the other service, or an admin token, is 403 on notify routes", async () => {
  assert.equal(
    (await call("GET", "/service/notify/channels", { token: statusSecret })).status,
    403,
  );
  assert.equal((await call("GET", "/service/notify/channels")).status, 403);
  assert.equal((await call("GET", "/admin/notify/channels", { token: notifySecret })).status, 403);
  assert.equal((await call("GET", "/admin/notify/failed", { token: statusSecret })).status, 403);
});

test("metric labels are the literal route patterns", async () => {
  await call("GET", "/admin/notify/channels");
  await call("PUT", "/admin/notify/channels/ops", { body: {} });
  await call("GET", "/admin/notify/failed");
  await call("GET", "/service/notify/channels", { token: notifySecret });
  await putReport(JSON.stringify(report()));
  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const route of [
    "/admin/notify/channels",
    "/admin/notify/channels/:id",
    "/admin/notify/failed",
    "/service/notify/channels",
    "/service/notify/report",
  ]) {
    assert.match(metrics, new RegExp(`pulse_api_http_requests_total\\{route="${route}"`), route);
  }
  assert.doesNotMatch(metrics, /route="\/admin\/notify\/channels\/ops"/);
});
