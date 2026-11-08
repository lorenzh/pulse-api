// Self-test of one side and round: each phase retries a bind failure once, with one value per metric.
import assert from "node:assert/strict";
import type { Samples } from "../compare.ts";
import type { EodResult } from "../eod.ts";
import type { TeardownCheck } from "../invocation.ts";
import { CommandExitError } from "../measure.ts";
import { measureStack, type SideRoundDeps } from "../side-round.ts";
import type { SideDirs, StackIdentity, StackMetrics } from "../stack.ts";

const PROJECT = "pulse-bench-0a1b2c3d4e5f-a";
const BIND = "Bind for 127.0.0.1:20001 failed: port is already allocated";
const upApi = ["compose", "-p", PROJECT, "up", "-d", "--no-build", "api"];
const upRest = ["compose", "-p", PROJECT, "up", "-d", "--no-build", "probe", "status", "notify"];
const restartApi = ["compose", "-p", PROJECT, "restart", "api"];
const bindError = (args: string[]): CommandExitError =>
  new CommandExitError("docker", args, 1, `${BIND}\n`);

type Step = "ok" | Error;
type Phase = "load" | "cold" | "eod";

const perService = (n: number) => ({ api: n, probe: n, status: n, notify: n });
const metrics = (n: number): StackMetrics => ({
  startupCpuMs: perService(n),
  startupWallMs: perService(n),
  idleRssMiB: perService(n),
  peakRssMiB: perService(n),
  loadCpuS: perService(n),
  p95GetChecksMs: n,
  p95PostResultsMs: n,
  p95GetLatencyMs: null,
  p95GetCheckLatencyMs: n,
  rps: n,
});
const eodResult = (n: number): EodResult & { today_rows: number } => ({
  eod_get_checks_ms: n,
  eod_get_uptime_ms: n,
  eod_get_latency_ms: n,
  eod_get_check_latency_ms: n,
  eod_get_components_ms: null,
  eod_get_components_uptime_ms: n,
  eod_read_cpu_ms: n,
  medians: {},
  vm_rss_mib: n,
  utc_start: "2026-11-08T12:00:00.000Z",
  today_rows: 1,
});

const dirs: SideDirs = {
  side: "a",
  work: {},
  seedDb: "/seed/pulse.db",
  coldSeedDb: "/seed/pulse-10x.db",
  missingRoutes: [],
};

function harness(plan: Partial<Record<Phase, Step[]>>, checks: TeardownCheck[] = []) {
  const events: string[] = [];
  const identities: StackIdentity[] = [];
  let next = 0;
  let value = 0;
  const step = (phase: Phase, identity: StackIdentity): void => {
    identities.push(identity);
    events.push(`${phase} ${identity.project} ${identity.ports?.api}`);
    const s = plan[phase]?.shift();
    if (s !== undefined && s !== "ok") throw s;
    value++;
  };
  const deps: SideRoundDeps = {
    runStack: async (_d, identity) => {
      step("load", identity);
      return metrics(value);
    },
    runColdStack: async (_d, identity) => {
      step("cold", identity);
      return {
        cold_get_checks_ms: value,
        cold_get_uptime_ms: value,
        cold_read_cpu_ms: value,
        cold_concurrent_ms: value,
        warm_get_checks_ms: value,
        warm_get_uptime_ms: value,
        warm_settle_ms: value,
        utc_start: "2026-11-08T12:00:00.000Z",
        utc_concurrent: "2026-11-08T12:00:01.000Z",
      };
    },
    runEodStack: async (_d, identity, _f, _r, _l, _o, confirm) => {
      events.push("closure");
      await confirm();
      step("eod", identity);
      return eodResult(value);
    },
    imageSizeMB: async (identity) => {
      assert.deepEqual(identity, { project: PROJECT, ports: null });
      return 100;
    },
    allocate: async (exclude) => {
      const block = next++;
      events.push(`allocate ${block} [${exclude.join(",")}]`);
      const g = 20000 + 5 * block;
      return {
        block,
        ports: { api: g + 1, probe: g + 2, status: g + 3, notify: g + 4 },
        release: async () => {
          events.push(`release ${block}`);
        },
      };
    },
    confirmTeardown: async (project) => {
      events.push(`confirm ${project}`);
      return checks.shift() ?? { isConfirmed: true };
    },
    removeDir: async (path) => {
      events.push(`removeDir ${path}`);
    },
    moveFailureLog: async () => undefined,
    log: () => undefined,
    id: "0a1b2c3d4e5f",
    workRoot: "/w/.bench/0a1b2c3d4e5f",
    composeFile: "/repo/bench/compose.bench.yaml",
    out: "/out",
  };
  const samples: Samples = {};
  const missingOnA = new Set<string>();
  const run = measureStack(deps, dirs, samples, 1, missingOnA, {
    mode: null,
    expectReports: [],
  });
  return { run, events, identities, samples, missingOnA };
}

const count = (events: string[], prefix: string): number =>
  events.filter((e) => e.startsWith(prefix)).length;

const API_KEYS = [
  "startup_cpu_ms",
  "startup_wall_ms",
  "idle_rss_mib",
  "peak_rss_mib",
  "load_cpu_s",
  "image_mb",
  "p95_get_checks_ms",
  "p95_post_results_ms",
  "p95_get_check_latency_ms",
  "rps",
  "cold_get_checks_ms",
  "cold_get_uptime_ms",
  "cold_read_cpu_ms",
  "cold_concurrent_ms",
  "eod_get_checks_ms",
  "eod_get_uptime_ms",
  "eod_get_latency_ms",
  "eod_get_check_latency_ms",
  "eod_get_components_uptime_ms",
  "eod_read_cpu_ms",
];

function assertOneValueEach(h: ReturnType<typeof harness>): void {
  assert.deepEqual(Object.keys(h.samples.api ?? {}), API_KEYS);
  for (const service of ["api", "probe", "status", "notify"]) {
    for (const [metric, values] of Object.entries(h.samples[service] ?? {})) {
      assert.equal(values.length, 1, `${service}.${metric}`);
    }
  }
  assert.deepEqual(Object.keys(h.samples.probe ?? {}), API_KEYS.slice(0, 6));
  assert.deepEqual([...h.missingOnA], ["api.p95_get_latency_ms", "api.eod_get_components_ms"]);
}

{
  const h = harness({});
  await h.run;
  assertOneValueEach(h);
  assert.deepEqual(h.events, [
    "allocate 0 []",
    "removeDir /w/.bench/0a1b2c3d4e5f/run/a",
    `load ${PROJECT} 20001`,
    `confirm ${PROJECT}`,
    "release 0",
    "allocate 1 []",
    "removeDir /w/.bench/0a1b2c3d4e5f/run-cold/a",
    `cold ${PROJECT} 20006`,
    `confirm ${PROJECT}`,
    "release 1",
    "allocate 2 []",
    "removeDir /w/.bench/0a1b2c3d4e5f/run-eod/a",
    "closure",
    `confirm ${PROJECT}`,
    `eod ${PROJECT} 20011`,
    `confirm ${PROJECT}`,
    "release 2",
  ]);
  assert.deepEqual(h.identities[0], {
    project: PROJECT,
    ports: { api: 20001, probe: 20002, status: 20003, notify: 20004 },
  });
}

for (const args of [upApi, upRest]) {
  const h = harness({ load: [bindError(args), "ok"] });
  await h.run;
  assertOneValueEach(h);
  assert.equal(count(h.events, "load"), 2);
  assert.deepEqual(
    h.identities.slice(0, 2).map((i) => i.ports),
    [
      { api: 20001, probe: 20002, status: 20003, notify: 20004 },
      { api: 20006, probe: 20007, status: 20008, notify: 20009 },
    ],
  );
  assert.equal(h.events[5], "allocate 1 [0]");
  assert.equal(h.samples.api?.load_cpu_s?.[0], 1, "only the successful attempt counts");
}

{
  const h = harness({ load: [bindError(upApi), bindError(upRest), "ok"] });
  await assert.rejects(
    h.run,
    (err) =>
      err instanceof Error &&
      err.name === "PortBindError" &&
      err.message.startsWith("host port bind failed twice: load on a (ports 20006,"),
  );
  assert.equal(count(h.events, "load"), 2);
  assert.equal(count(h.events, "cold"), 0);
  assert.deepEqual(h.samples, {});
}

for (const phase of ["cold", "eod"] as const) {
  const h = harness({ [phase]: [bindError(restartApi), "ok"] });
  await h.run;
  assertOneValueEach(h);
  assert.equal(count(h.events, `${phase} `), 2);
}

{
  const h = harness({ load: [bindError(upApi), "ok"], cold: [bindError(restartApi), "ok"] });
  await h.run;
  assertOneValueEach(h);
}

{
  const timeout = new Error("api was not ready within 120 s");
  const h = harness({ load: [timeout] });
  await assert.rejects(h.run, (err) => err === timeout);
  assert.equal(count(h.events, "load"), 1);
}

{
  const stuck = {
    isConfirmed: false as const,
    reason: "1 containers remain after compose down (exit 1)",
  };
  const h = harness({ cold: [bindError(restartApi), "ok"] }, [{ isConfirmed: true }, stuck]);
  await assert.rejects(
    h.run,
    (err) =>
      err instanceof Error &&
      err.name === "PortBindError" &&
      err.message.startsWith("host port bind failed, retry skipped"),
  );
  assert.equal(count(h.events, "cold"), 1);
  assert.equal(count(h.events, "eod"), 0);
  assert.equal(count(h.events, "release"), 1, "only the load lease is released");
  assert.equal(h.samples.api?.cold_get_checks_ms, undefined);
}

{
  const stuck = {
    isConfirmed: false as const,
    reason: "1 containers remain after compose down (exit 1)",
  };
  const h = harness({}, [stuck]);
  await assert.rejects(h.run, (err) => err instanceof Error && err.name === "TeardownError");
  assert.deepEqual(h.samples, {});
  assert.equal(count(h.events, "release"), 0);
}

console.log("check-side-round: ok");
