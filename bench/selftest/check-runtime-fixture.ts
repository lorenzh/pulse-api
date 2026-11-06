// Self-test of the service tokens, the runtime fixture and the report check, with a fake api.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReport,
  type Fetch,
  prepareRuntime,
  type RuntimeDeps,
  type RuntimeMode,
  type RuntimeService,
  runtimeMode,
  type Side,
  writeTokenFile,
} from "../runtime-fixture.ts";

const BASELINE =
  '{"error":"token.scopes[0]: must be one of \\"read\\", \\"checks\\", \\"incidents\\", \\"admin\\", \\"probe\\""}';

type Answer = { status: number; body: string };
type TokenAnswers = Record<RuntimeService, Answer>;

const created = (scope: RuntimeService): Answer => ({
  status: 201,
  body: JSON.stringify({
    token: { id: scope },
    secret: `secret-${scope}`,
    previousValidUntil: null,
  }),
});
const BOTH_CREATED: TokenAnswers = { status: created("status"), notify: created("notify") };

interface FakeApi {
  fetch: Fetch;
  calls: string[];
}

/** A fake api: token answers per scope, 200/201 with an ETag for the fixture writes. */
function fakeApi(tokens: TokenAnswers, failWrite = false, view: unknown = undefined): FakeApi {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    if (path === "/admin/tokens") {
      const scope = JSON.parse(String(init?.body)).scopes[0] as RuntimeService;
      return new Response(tokens[scope].body, { status: tokens[scope].status });
    }
    if (method === "GET") {
      return new Response(JSON.stringify(view ?? {}), { status: 200, headers: { etag: '"e0"' } });
    }
    if (failWrite) return new Response('{"error":"x"}', { status: 412 });
    return new Response("{}", { status: method === "POST" ? 201 : 200, headers: { etag: '"e1"' } });
  };
  return { fetch, calls };
}

function deps(side: Side, api: FakeApi, lines: string[]): RuntimeDeps {
  return { apiUrl: "http://api.test", side, fetch: api.fetch, log: (l) => lines.push(l) };
}

const noWrite = async (): Promise<void> => {
  throw new Error("no token file expected");
};

async function refused(
  side: Side,
  mode: RuntimeMode,
  tokens: TokenAnswers,
  text: RegExp,
): Promise<void> {
  const lines: string[] = [];
  await assert.rejects(prepareRuntime(deps(side, fakeApi(tokens), lines), mode, noWrite), text);
  assert.ok(!lines.includes("service traffic: not available on a"));
}

const writes = (calls: string[]): string[] => calls.filter((c) => !c.startsWith("GET"));

// No option: no request at all and empty token variables.
{
  const api = fakeApi(BOTH_CREATED);
  const prepared = await prepareRuntime(deps("b", api, []), null, noWrite);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(prepared.env, { BENCH_STATUS_TOKEN_FILE: "", BENCH_NOTIFY_TOKEN_FILE: "" });
  assert.equal(prepared.tokens, null);
}

// --service-tokens, 201 on both sides: both files (mode 0644), both variables, the fixture.
for (const side of ["a", "b"] as const) {
  const dir = await mkdtemp(join(tmpdir(), "bench-tokens-"));
  try {
    const api = fakeApi(BOTH_CREATED);
    const prepared = await prepareRuntime(deps(side, api, []), "tokens", (name, secret) =>
      writeTokenFile(dir, name, secret),
    );
    assert.deepEqual(prepared.env, {
      BENCH_STATUS_TOKEN_FILE: "/service-tokens/status",
      BENCH_NOTIFY_TOKEN_FILE: "/service-tokens/notify",
    });
    for (const name of ["status", "notify"] as const) {
      assert.equal(await readFile(join(dir, name), "utf8"), `secret-${name}`);
      assert.equal((await stat(join(dir, name))).mode & 0o777, 0o644);
    }
    assert.deepEqual(writes(api.calls), [
      "POST /admin/tokens",
      "POST /admin/tokens",
      "PUT /admin/status/settings",
      "POST /admin/notify/channels",
      "POST /admin/notify/channels",
      "POST /admin/notify/channels",
      "POST /admin/notify/channels",
      "POST /admin/notify/channels",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The token mode never falls back, not even on A with the baseline answer.
for (const side of ["a", "b"] as const) {
  await refused(
    side,
    "tokens",
    { ...BOTH_CREATED, status: { status: 400, body: BASELINE } },
    /service tokens: 400 on/,
  );
}

// --simulate-services: the baseline answer turns only A off, for either requested scope.
for (const scope of ["status", "notify"] as const) {
  const lines: string[] = [];
  const api = fakeApi({ ...BOTH_CREATED, [scope]: { status: 400, body: BASELINE } });
  const prepared = await prepareRuntime(deps("a", api, lines), "simulate", noWrite);
  assert.equal(prepared.tokens, null);
  assert.deepEqual(lines, ["service traffic: not available on a"]);
  assert.deepEqual(writes(api.calls), ["POST /admin/tokens", "POST /admin/tokens"]);
  await refused(
    "b",
    "simulate",
    { ...BOTH_CREATED, [scope]: { status: 400, body: BASELINE } },
    /service tokens: 400 on b/,
  );
}

// 201 on A turns the simulation on for A too.
{
  const api = fakeApi(BOTH_CREATED);
  const prepared = await prepareRuntime(deps("a", api, []), "simulate", noWrite);
  assert.deepEqual(prepared.tokens, { status: "secret-status", notify: "secret-notify" });
  assert.deepEqual(prepared.env, { BENCH_STATUS_TOKEN_FILE: "", BENCH_NOTIFY_TOKEN_FILE: "" });
  assert.equal(writes(api.calls).length, 8);
}

// Every other answer on A is a harness error.
const otherAnswers: [RuntimeService, Answer, RegExp][] = [
  ["status", { status: 400, body: '{"error":"scopes: must be one of \\"read\\""}' }, /400 on a/],
  ["status", { status: 400, body: '{"error":"token.name: is required"}' }, /400 on a/],
  [
    "status",
    { status: 400, body: '{"error":"token.scopes[0]: must be one of \\"read\\", \\"status\\""}' },
    /400 on a/,
  ],
  [
    "notify",
    { status: 400, body: '{"error":"token.scopes[0]: must be one of \\"read\\", \\"notify\\""}' },
    /400 on a/,
  ],
  ["status", { status: 400, body: "token.scopes[0]: must be one of " }, /400 on a/],
  ["status", { status: 400, body: '{"error":5}' }, /400 on a/],
  ["status", { status: 400, body: '{"message":"token.scopes[0]: must be one of "}' }, /400 on a/],
  ["status", { status: 500, body: BASELINE }, /500 on a/],
  ["notify", { status: 401, body: '{"error":"unauthorized"}' }, /401 on a/],
  ["status", { status: 201, body: "{}" }, /201 on a/],
];
for (const [scope, answer, text] of otherAnswers) {
  await refused("a", "simulate", { ...BOTH_CREATED, [scope]: answer }, text);
}

// A failing fixture write is a harness error.
await assert.rejects(
  prepareRuntime(deps("b", fakeApi(BOTH_CREATED, true), []), "simulate", noWrite),
  /fixture: PUT \/admin\/status\/settings 412 on b/,
);

// Both options together are a usage error.
assert.throws(() => runtimeMode(true, true), /exclude each other/);
assert.equal(runtimeMode(true, false), "simulate");
assert.equal(runtimeMode(false, true), "tokens");
assert.equal(runtimeMode(false, false), null);

// The report check: B needs a fresh report of the current revision; A only logs.
const view = (state: string, applied: string | null): unknown => ({
  revision: "sha256-r1",
  service:
    state === "never"
      ? { state, receivedAt: null, report: null }
      : { state, receivedAt: 1, report: { appliedRevision: applied } },
});
for (const service of ["status", "notify"] as const) {
  const lines: string[] = [];
  await checkReport(
    deps("b", fakeApi(BOTH_CREATED, false, view("fresh", "sha256-r1")), lines),
    service,
  );
  assert.deepEqual(lines, [`${service} report on b: fresh, applied sha256-r1`]);
  for (const [state, applied] of [
    ["stale", "sha256-r1"],
    ["fresh", "sha256-r0"],
    ["fresh", null],
    ["never", null],
  ] as const) {
    await assert.rejects(
      checkReport(deps("b", fakeApi(BOTH_CREATED, false, view(state, applied)), []), service),
      new RegExp(`^HarnessError: ${service} report not observed on b$`),
    );
  }
  const onA: string[] = [];
  await checkReport(deps("a", fakeApi(BOTH_CREATED, false, view("never", null)), onA), service);
  assert.deepEqual(onA, [`${service} report on a: never`]);
}

console.log("check-runtime-fixture: ok");
