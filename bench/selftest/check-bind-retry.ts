// Self-test of the bind retry and confirmed teardown: only Docker bind failures retry, once, safely.
import assert from "node:assert/strict";
import { withBindRetry, withConfirmedReseed } from "../bind-retry.ts";
import { type EodResult, runEodPhase } from "../eod.ts";
import type { TeardownCheck } from "../invocation.ts";
import { CommandExitError } from "../measure.ts";
import type { PortLease } from "../ports.ts";

const CONFIRMED: TeardownCheck = { isConfirmed: true };
const STUCK: TeardownCheck = {
  isConfirmed: false,
  reason: "1 containers remain after compose down (exit 1)",
};
const ALLOCATED =
  "Error response from daemon: driver failed programming external connectivity on endpoint pulse-bench-0a1b2c3d4e5f-b-api: Bind for 127.0.0.1:20001 failed: port is already allocated";
const IN_USE =
  "failed to bind host port for 127.0.0.1:20006:172.18.0.3:9100/tcp: address already in use";
const UP = ["compose", "-p", "pulse-bench-0a1b2c3d4e5f-b", "up", "-d", "--no-build", "api"];

const dockerError = (stderr: string): CommandExitError =>
  new CommandExitError("docker", UP, 1, stderr);
const isNamed = (name: string, message?: string) => (err: unknown) =>
  err instanceof Error && err.name === name && (message === undefined || err.message === message);

type Step = "ok" | { error: unknown };

function drive(steps: Step[], checks: TeardownCheck[]) {
  const events: string[] = [];
  const lines: string[] = [];
  let next = 0;
  const run = withBindRetry<string>({
    phase: "load",
    side: "b",
    project: "pulse-bench-0a1b2c3d4e5f-b",
    failureLogFile: "/out/failure-round1-b.log",
    attempt1LogFile: "/out/failure-round1-b-load-attempt1.log",
    allocate: async (exclude): Promise<PortLease> => {
      const block = next++;
      events.push(`allocate ${block} excluding [${exclude.join(",")}]`);
      const guard = 20000 + 5 * block;
      return {
        block,
        ports: { api: guard + 1, probe: guard + 2, status: guard + 3, notify: guard + 4 },
        release: async () => {
          events.push(`release ${block}`);
        },
      };
    },
    removeRunDir: async () => {
      events.push("removeRunDir");
    },
    attempt: async (lease, file) => {
      events.push(`attempt ${lease.block} ${file}`);
      const step = steps.shift();
      if (step === undefined || step === "ok") return `result ${lease.block}`;
      throw step.error;
    },
    confirmTeardown: async () => {
      events.push("confirm");
      return checks.shift() ?? CONFIRMED;
    },
    moveFailureLog: async (from, to) => {
      events.push(`move ${from} ${to}`);
    },
    log: (line) => lines.push(line),
  });
  return { run, events, lines };
}

const count = (events: string[], prefix: string): number =>
  events.filter((e) => e.startsWith(prefix)).length;

const retried: unknown[] = [
  dockerError(ALLOCATED),
  dockerError(IN_USE),
  dockerError(`${ALLOCATED.toUpperCase()}\n${"y".repeat(600)}`),
  new Error("api did not start", { cause: dockerError(IN_USE) }),
];
const notRetried: unknown[] = [
  dockerError("no space left on device"),
  new Error("api was not ready within 120 s"),
  new Error("GET /checks answered 500"),
  new CommandExitError("git", ["fetch"], 1, "address already in use"),
  Object.assign(new Error("no free bench port block in 20000-29999"), {
    name: "PortAllocationError",
  }),
];
for (const error of retried) {
  const { run, events } = drive([{ error }, "ok"], []);
  assert.equal(await run, "result 1");
  assert.equal(count(events, "attempt"), 2, `retried: ${String(error)}`);
}
for (const error of notRetried) {
  const { run, events } = drive([{ error }], []);
  await assert.rejects(run, (err) => err === error);
  assert.equal(count(events, "attempt"), 1, `not retried: ${String(error)}`);
  assert.deepEqual(
    events.at(-1),
    "move /out/failure-round1-b-load-attempt1.log /out/failure-round1-b.log",
  );
}

{
  const { run, events, lines } = drive([{ error: dockerError(ALLOCATED) }, "ok"], []);
  assert.equal(await run, "result 1");
  assert.deepEqual(events, [
    "allocate 0 excluding []",
    "removeRunDir",
    "attempt 0 /out/failure-round1-b-load-attempt1.log",
    "confirm",
    "release 0",
    "allocate 1 excluding [0]",
    "removeRunDir",
    "attempt 1 /out/failure-round1-b.log",
    "confirm",
    "release 1",
  ]);
  assert.deepEqual(lines, [
    "bind retry: load on b: host port in use, retrying once with new ports",
  ]);
}

{
  const { run, events } = drive(["ok"], []);
  assert.equal(await run, "result 0");
  assert.equal(count(events, "allocate"), 1);
  assert.equal(count(events, "attempt"), 1);
}

{
  const second = dockerError(`noise\n${IN_USE}\nmore`);
  const { run, events } = drive([{ error: dockerError(ALLOCATED) }, { error: second }, "ok"], []);
  await assert.rejects(
    run,
    (err) =>
      isNamed(
        "PortBindError",
        `host port bind failed twice: load on b (ports 20006,20007,20008,20009): ${IN_USE}`,
      )(err) &&
      err instanceof Error &&
      err.cause === second,
  );
  assert.equal(count(events, "attempt"), 2);
  assert.equal(count(events, "release"), 2);
}

{
  const long = `port is already allocated ${"z".repeat(400)}`;
  const { run } = drive([{ error: dockerError(long) }, { error: dockerError(long) }], []);
  await assert.rejects(
    run,
    (err) => err instanceof Error && err.message.endsWith(long.slice(0, 300)),
  );
}

for (const check of [STUCK, { isConfirmed: false as const, reason: "docker ps exited with 1" }]) {
  const first = dockerError(ALLOCATED);
  const { run, events, lines } = drive([{ error: first }, "ok"], [check]);
  await assert.rejects(
    run,
    (err) =>
      isNamed(
        "PortBindError",
        `host port bind failed, retry skipped because teardown was not confirmed: load on b (ports 20001,20002,20003,20004): ${ALLOCATED}`,
      )(err) &&
      err instanceof Error &&
      err.cause === first,
  );
  assert.equal(count(events, "attempt"), 1);
  assert.equal(count(events, "removeRunDir"), 1);
  assert.equal(count(events, "release"), 0);
  assert.deepEqual(lines, [
    `teardown not confirmed: load on b (project pulse-bench-0a1b2c3d4e5f-b): ${check.reason}`,
  ]);
}

{
  const { run, events } = drive(["ok"], [STUCK]);
  await assert.rejects(
    run,
    isNamed(
      "TeardownError",
      "teardown not confirmed: load on b (project pulse-bench-0a1b2c3d4e5f-b): 1 containers remain after compose down (exit 1)",
    ),
  );
  assert.equal(count(events, "release"), 0);
}

{
  const timeout = new Error("api was not ready within 120 s");
  const { run, events, lines } = drive([{ error: timeout }], [STUCK]);
  await assert.rejects(run, (err) => err === timeout);
  assert.equal(count(events, "release"), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^teardown not confirmed: load on b/);
}

{
  const { run } = drive(
    [{ error: dockerError(ALLOCATED) }, { error: dockerError(ALLOCATED) }],
    [CONFIRMED, STUCK],
  );
  await assert.rejects(
    run,
    (err) => err instanceof Error && /^host port bind failed twice/.test(err.message),
  );
}

const LATE = Date.parse("2026-11-08T23:59:30Z");
const NEXT = Date.parse("2026-11-09T00:11:00Z");
const NOON = Date.parse("2026-11-08T12:00:00Z");
const fakeResult = (n: number): EodResult => ({
  eod_get_checks_ms: n,
  eod_get_uptime_ms: n,
  eod_get_latency_ms: n,
  eod_get_check_latency_ms: n,
  eod_get_components_ms: n,
  eod_get_components_uptime_ms: n,
  eod_read_cpu_ms: n,
  medians: {},
  vm_rss_mib: n,
  utc_start: "2026-11-08T00:00:00.000Z",
});

function eod(times: number[], checks: TeardownCheck[]) {
  const events: string[] = [];
  let measures = 0;
  const phase = withConfirmedReseed(
    {
      seed: async (now) => {
        events.push(`seed(${new Date(now).toISOString()})`);
        return 5;
      },
      measure: async () => {
        events.push("measure");
        measures++;
        return fakeResult(measures);
      },
    },
    {
      confirmTeardown: async () => {
        events.push("confirm");
        return checks.shift() ?? CONFIRMED;
      },
      side: "b",
      project: "pulse-bench-0a1b2c3d4e5f-b",
    },
  );
  const clock = [...times];
  const run = runEodPhase(
    phase,
    () => undefined,
    () => clock.shift() ?? Number.NaN,
    async () => undefined,
  );
  return { run, events };
}

{
  const { run, events } = eod(
    [LATE, LATE, NEXT, NEXT, NEXT, NEXT + 60_000],
    [CONFIRMED, CONFIRMED],
  );
  const result = await run;
  assert.equal(result.eod_read_cpu_ms, 2, "the second pass is the result");
  assert.deepEqual(events, [
    "confirm",
    "seed(2026-11-08T23:59:30.000Z)",
    "measure",
    "confirm",
    "seed(2026-11-09T00:11:00.000Z)",
    "measure",
  ]);
}

let reseedError: unknown;
{
  const { run, events } = eod([LATE, LATE, NEXT, NEXT, NEXT, NEXT + 60_000], [CONFIRMED, STUCK]);
  await run.then(
    () => assert.fail("the reseed must stop"),
    (err: unknown) => {
      reseedError = err;
    },
  );
  assert.ok(
    isNamed(
      "TeardownError",
      "teardown not confirmed: eod on b (project pulse-bench-0a1b2c3d4e5f-b): 1 containers remain after compose down (exit 1)",
    )(reseedError),
  );
  assert.deepEqual(events, ["confirm", "seed(2026-11-08T23:59:30.000Z)", "measure", "confirm"]);
  assert.deepEqual(
    [count(events, "confirm"), count(events, "seed"), count(events, "measure")],
    [2, 1, 1],
  );
}

{
  const { run, events } = eod([NOON, NOON, NOON + 60_000], []);
  assert.equal((await run).today_rows, 5);
  assert.deepEqual(events, ["confirm", "seed(2026-11-08T12:00:00.000Z)", "measure"]);
}

{
  const { run, events } = eod([NOON, NOON, NOON + 60_000], [STUCK]);
  await assert.rejects(run, isNamed("TeardownError"));
  assert.deepEqual(events, ["confirm"]);
}

{
  const { run, events } = drive([{ error: reseedError }], []);
  await assert.rejects(run, (err) => err === reseedError);
  assert.equal(count(events, "attempt"), 1);
  assert.equal(count(events, "confirm"), 1);
}

console.log("check-bind-retry: ok");
