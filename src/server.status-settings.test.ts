import { Database } from "bun:sqlite";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminStatusSettingsView,
  type AuditPage,
  type ServiceStatusSettings,
  type StatusServiceReport,
  validateAdminStatusSettingsView,
  validateServiceStatusSettings,
} from "@lorenzh/pulse-contract";
import { openDb } from "./db.ts";
import { type RunningApi, startApi } from "./start.ts";

const ADMIN = "admin-status-0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-11-06T12:00:00Z");
const ID64 = (n: number): string => `c${String(n).padStart(3, "0")}${"x".repeat(60)}`;
const COMPONENT_COUNT = 500;

let dir = "";
let api: RunningApi;
let base = "";
let clock = NOW;
let statusSecret = "";
const lines: string[] = [];

beforeEach(async () => {
  clock = NOW;
  lines.length = 0;
  dir = mkdtempSync(join(tmpdir(), "pulse-status-settings-"));
  const checksFile = join(dir, "checks.json");
  const adminFile = join(dir, "admin.json");
  const components = [
    { id: "web", name: "Web", checkIds: ["a"] },
    { id: "api", name: "API", checkIds: ["a"] },
    ...Array.from({ length: COMPONENT_COUNT }, (_, i) => ({
      id: ID64(i),
      name: `C${i}`,
      checkIds: ["a"],
    })),
  ];
  writeFileSync(
    checksFile,
    JSON.stringify({
      checks: [{ id: "a", name: "A", url: "https://a.example/", intervalMs: 60000 }],
      components,
    }),
  );
  writeFileSync(adminFile, JSON.stringify({ tokens: [{ name: "ops", token: ADMIN }] }));
  const tokensFile = join(dir, "tokens.json");
  writeFileSync(
    tokensFile,
    JSON.stringify({ tokens: [{ location: "eu", token: "probe-status-0123456789abcdef" }] }),
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
  const made = await call("POST", "/admin/tokens", { body: { name: "sp", scopes: ["status"] } });
  assert.equal(made.status, 201);
  statusSecret = ((await made.json()) as { secret: string }).secret;
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

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

async function adminView(): Promise<{ view: AdminStatusSettingsView; etag: string }> {
  const r = await call("GET", "/admin/status/settings");
  assert.equal(r.status, 200);
  const v = validateAdminStatusSettingsView(await r.json());
  if (!v.ok) throw new Error(v.error);
  const etag = r.headers.get("etag");
  assert.ok(etag);
  return { view: v.value, etag };
}

function put(settings: unknown, ifMatch: string | undefined): Promise<Response> {
  return call("PUT", "/admin/status/settings", {
    body: settings,
    headers: ifMatch === undefined ? {} : { "if-match": ifMatch },
  });
}

function putReport(raw: string): Promise<Response> {
  return call("PUT", "/service/status/report", { raw, token: statusSecret });
}

function auditRows(): { action: string; target_kind: string; target_id: string }[] {
  const db = new Database(join(dir, "pulse.db"), { readonly: true });
  try {
    return db.query("SELECT action, target_kind, target_id FROM audit_log ORDER BY id").all() as {
      action: string;
      target_kind: string;
      target_id: string;
    }[];
  } finally {
    db.close();
  }
}

/** A status code for a request with a raw body; used where fetch would refuse or buffer. */
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

const REPORT: StatusServiceReport = {
  at: NOW,
  startedAt: NOW - 1000,
  appliedRevision: null,
  rejected: null,
  locked: [{ field: "name", source: "env", via: "PULSE_STATUS_NAME", value: "Local" }],
};

/** `REPORT` padded with JSON whitespace to exactly `bytes` bytes. */
function reportOf(bytes: number): string {
  const text = JSON.stringify(REPORT);
  return `${text}${" ".repeat(bytes - Buffer.byteLength(text))}`;
}

function largestSettings(): Record<string, unknown> {
  const color = "#aabbccdd";
  const palette = Object.fromEntries(
    [
      "bg",
      "surface",
      "rule",
      "line-strong",
      "field-line",
      "text",
      "lead",
      "muted",
      "accent",
      "accent-text",
      "tint",
      "tint-line",
      "success",
      "success-tint",
      "warning",
      "warning-tint",
      "error",
      "error-tint",
      "info",
      "info-tint",
    ].map((k) => [k, color]),
  );
  const font = `"${"F".repeat(198)}"`;
  const radius = `${"1".repeat(30)}px`;
  const logo = `https://logo.example/${"l".repeat(2048 - "https://logo.example/".length)}`;
  return {
    name: "N".repeat(60),
    logoUrl: logo,
    theme: {
      light: palette,
      dark: palette,
      "font-sans": font,
      "font-mono": font,
      "radius-sm": radius,
      "radius-md": radius,
      "radius-pill": radius,
    },
    componentOrder: Array.from({ length: COMPONENT_COUNT }, (_, i) => ID64(i)),
    showChecks: true,
    showLatency: false,
    showSlos: false,
    hideDetails: false,
  };
}

test("admin GET: never before a report, no-store, an etag, and never 304", async () => {
  const { view, etag } = await adminView();
  assert.deepEqual(view.settings, {});
  assert.deepEqual(view.service, { state: "never", receivedAt: null, report: null });
  const again = await call("GET", "/admin/status/settings", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("cache-control"), "no-store");
  assert.equal(again.headers.get("etag"), etag);
});

test("PUT: If-Match missing 428, malformed 400, stale 412, current 200 with a new etag", async () => {
  const { etag } = await adminView();
  assert.equal((await put({ name: "Acme" }, undefined)).status, 428);
  assert.equal((await put({ name: "Acme" }, etag.slice(1, -1))).status, 400);
  assert.equal((await put({ name: "Acme" }, '"sha256-nothex"')).status, 400);
  const ok = await put({ name: "Acme" }, etag);
  assert.equal(ok.status, 200);
  const next = ok.headers.get("etag");
  assert.ok(next !== null && next !== etag);
  const saved = validateAdminStatusSettingsView(await ok.json());
  assert.ok(saved.ok);
  assert.deepEqual(saved.value.settings, { name: "Acme" });
  const stale = await put({ name: "Other" }, etag);
  assert.equal(stale.status, 412);
  assert.deepEqual(await stale.json(), { error: "the settings changed: reload them and retry" });
  // A PUT replaces the whole document: an absent field falls back to its default.
  const reset = await put({ showLatency: false }, next);
  assert.equal(reset.status, 200);
  assert.deepEqual((await adminView()).view.settings, { showLatency: false });
});

test("PUT audits status-settings.replace with no settings value", async () => {
  const { etag } = await adminView();
  const before = auditRows().length;
  assert.equal((await put({ name: "SENTINEL-NAME", showChecks: true }, etag)).status, 200);
  const rows = auditRows().slice(before);
  assert.deepEqual(rows, [
    { action: "status-settings.replace", target_kind: "status-settings", target_id: "status" },
  ]);
  const page = (await (await call("GET", "/admin/audit")).json()) as AuditPage;
  assert.doesNotMatch(JSON.stringify(page), /SENTINEL-NAME/);
  assert.ok(lines.every((l) => !l.includes("SENTINEL-NAME")));
});

test("check and status revisions stay independent", async () => {
  const config = await call("GET", "/admin/config");
  const checkTag = config.headers.get("etag") ?? "";
  const { etag } = await adminView();
  const check = { id: "b", name: "B", url: "https://b.example/", intervalMs: 60000 };
  const created = await call("POST", "/admin/checks", {
    body: check,
    headers: { "if-match": checkTag },
  });
  assert.equal(created.status, 201);
  // The check write did not stale the status save ...
  assert.equal((await put({ name: "Acme" }, etag)).status, 200);
  // ... and the status save did not stale the next check write.
  const nextCheckTag = created.headers.get("etag") ?? "";
  const replaced = await call("PUT", "/admin/checks/b", {
    body: { ...check, name: "B2" },
    headers: { "if-match": nextCheckTag },
  });
  assert.equal(replaced.status, 200);
});

test("422: invalid, unknown or duplicate component, and the field limits", async () => {
  const { etag } = await adminView();
  const big = { name: "x" };
  const pad = 65_537 - Buffer.byteLength(JSON.stringify({ ...big, logoUrl: "" }));
  const cases: [string, unknown][] = [
    ["unknown component", { componentOrder: ["web", "gone"] }],
    ["duplicate component", { componentOrder: ["web", "web"] }],
    ["uppercase id", { componentOrder: ["Web"] }],
    ["id of 65", { componentOrder: [`a${"b".repeat(64)}`] }],
    ["radius 33", { theme: { "radius-sm": `${"1".repeat(31)}px` } }],
    ["logo with space", { logoUrl: "https://logo.example/a b.png" }],
    ["logo non-ASCII", { logoUrl: "https://logo.example/é.png" }],
    ["65537 bytes", { ...big, logoUrl: `https://x.example/${"a".repeat(pad - 18)}` }],
    ["unknown field", { title: "x" }],
    ["null setting", { name: null }],
  ];
  const sizeCase = cases[7]?.[1];
  assert.equal(Buffer.byteLength(JSON.stringify(sizeCase)), 65_537);
  for (const [label, body] of cases) {
    assert.equal((await put(body, etag)).status, 422, label);
  }
  const unknown = await put({ componentOrder: ["web", "gone"] }, etag);
  assert.deepEqual(await unknown.json(), {
    error: "settings.componentOrder[1]: must reference a current component",
  });
  assert.equal((await adminView()).etag, etag);
  assert.equal(auditRows().filter((r) => r.action === "status-settings.replace").length, 0);
});

test("the largest valid settings are accepted and served within 65656 bytes", async () => {
  const settings = largestSettings();
  const bytes = Buffer.byteLength(JSON.stringify(settings));
  assert.ok(bytes < 40_000, `largest settings are ${bytes} bytes`);
  const { etag } = await adminView();
  assert.equal((await put(settings, etag)).status, 200);
  const r = await call("GET", "/service/status/settings", { token: statusSecret });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(Buffer.byteLength(text) <= 65_656, `service answer is ${Buffer.byteLength(text)}`);
  const v = validateServiceStatusSettings(JSON.parse(text));
  assert.ok(v.ok);
  assert.deepEqual(v.value.settings, settings);
});

test("a body over 1048576 bytes is 413 before any write", async () => {
  const { etag } = await adminView();
  const raw = JSON.stringify({ name: "x".repeat(1_048_577) });
  const r = await call("PUT", "/admin/status/settings", { raw, headers: { "if-match": etag } });
  assert.equal(r.status, 413);
  assert.equal((await adminView()).etag, etag);
  assert.equal(await rawStatus("GET", "/admin/status/settings", raw, ADMIN), 413);
  assert.equal(await rawStatus("GET", "/service/status/settings", raw, statusSecret), 413);
});

test("service GET: the revision as etag and 304 on a matching If-None-Match", async () => {
  const { etag } = await adminView();
  const r = await call("GET", "/service/status/settings", { token: statusSecret });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("etag"), etag);
  const body = (await r.json()) as ServiceStatusSettings;
  assert.deepEqual(body, { revision: etag.slice(1, -1), settings: {} });
  const cached = await call("GET", "/service/status/settings", {
    token: statusSecret,
    headers: { "if-none-match": etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const other = await call("GET", "/service/status/settings", {
    token: statusSecret,
    headers: { "if-none-match": '"sha256-0"' },
  });
  assert.equal(other.status, 200);
});

test("report: 524288 bytes 204, 524289 bytes 413 with the stored report unchanged", async () => {
  assert.equal((await putReport(reportOf(524_288))).status, 204);
  const first = (await adminView()).view.service;
  assert.equal(first.state, "fresh");
  assert.deepEqual(first.report, REPORT);
  assert.equal(first.receivedAt, NOW);
  clock += 10;
  const other = { ...REPORT, at: NOW + 5 };
  const raw = JSON.stringify(other);
  assert.equal(
    (await putReport(`${raw}${" ".repeat(524_289 - Buffer.byteLength(raw))}`)).status,
    413,
  );
  assert.deepEqual((await adminView()).view.service, first);
  assert.equal((await putReport("{")).status, 400);
  assert.equal((await putReport(JSON.stringify({ ...REPORT, at: -1 }))).status, 422);
  assert.deepEqual((await adminView()).view.service, first);
});

test("100 reports leave the etag equal and write no audit row", async () => {
  const { etag } = await adminView();
  const audits = auditRows().length;
  for (let i = 0; i < 100; i += 1) {
    assert.equal((await putReport(JSON.stringify({ ...REPORT, at: NOW + i }))).status, 204);
  }
  assert.equal((await adminView()).etag, etag);
  const service = await call("GET", "/service/status/settings", { token: statusSecret });
  assert.equal(service.headers.get("etag"), etag);
  assert.equal(auditRows().length, audits);
  assert.ok(lines.some((l) => l.includes("service report")));
  assert.ok(lines.every((l) => !l.includes("PULSE_STATUS_NAME")));
});

test("report state: fresh at 180000 ms, stale at 180001 ms", async () => {
  assert.equal((await putReport(JSON.stringify(REPORT))).status, 204);
  clock = NOW + 180_000;
  assert.equal((await adminView()).view.service.state, "fresh");
  clock = NOW + 180_001;
  const { view } = await adminView();
  assert.equal(view.service.state, "stale");
  assert.equal(view.service.receivedAt, NOW);
  assert.deepEqual(view.service.report, REPORT);
});

test("metric labels are the literal route patterns", async () => {
  await call("GET", "/admin/status/settings");
  await call("GET", "/service/status/settings", { token: statusSecret });
  await putReport(JSON.stringify(REPORT));
  await call("GET", "/service/status/nope", { token: statusSecret });
  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const route of [
    "/admin/status/settings",
    "/service/status/settings",
    "/service/status/report",
  ]) {
    assert.match(metrics, new RegExp(`pulse_api_http_requests_total\\{route="${route}"`), route);
  }
  assert.doesNotMatch(metrics, /route="\/service\/status\/nope"/);
});
