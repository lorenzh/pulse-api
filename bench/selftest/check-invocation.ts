// Self-test of the run identity: names, workspace checks, confirmed teardown and owned-only cleanup.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchImage,
  benchProject,
  cleanupInvocation,
  confirmTeardown,
  newInvocationId,
  portEnv,
  workspaceDir,
} from "../invocation.ts";

const ID = "0a1b2c3d4e5f";
const OTHER = "ffeeddccbbaa";
const FILE = "/repo/bench/compose.bench.yaml";

assert.equal(
  newInvocationId(() => Uint8Array.from([0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f])),
  ID,
);
assert.equal(benchProject(ID, "a"), "pulse-bench-0a1b2c3d4e5f-a");
assert.equal(benchProject(OTHER, "a"), "pulse-bench-ffeeddccbbaa-a");
assert.deepEqual(
  ["api", "probe", "status", "notify"].map((s) => benchImage(benchProject(ID, "a"), s)),
  [
    "pulse-bench-0a1b2c3d4e5f-a-api",
    "pulse-bench-0a1b2c3d4e5f-a-probe",
    "pulse-bench-0a1b2c3d4e5f-a-status",
    "pulse-bench-0a1b2c3d4e5f-a-notify",
  ],
);
assert.deepEqual(portEnv({ api: 20001, probe: 20002, status: 20003, notify: 20004 }), {
  BENCH_API_PORT: "20001",
  BENCH_PROBE_PORT: "20002",
  BENCH_STATUS_PORT: "20003",
  BENCH_NOTIFY_PORT: "20004",
});

const root = await mkdtemp(join(tmpdir(), "check-invocation-"));
const BAD_IDS = ["../x", "..", "/", "", "0A1B2C3D4E5F", "0a1b2c3d4e5", "0a1b2c3d4e5f0"];
try {
  assert.equal(workspaceDir(root, ID), join(root, ".bench", ID));
  for (const id of BAD_IDS) {
    assert.throws(() => workspaceDir(root, id), /invalid invocation id/, `id ${id}`);
  }

  interface Reply {
    code: number;
    stdout: string;
  }
  const fakeRunner = (replies: Reply[], calls: string[]) => {
    return async (command: string, args: readonly string[]): Promise<Reply> => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "image") return replies.shift() ?? { code: 0, stdout: "" };
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`unexpected command ${args.join(" ")}`);
      return reply;
    };
  };
  const PROJECT = "pulse-bench-0a1b2c3d4e5f-a";
  const ps = `docker ps -a -q --filter label=com.docker.compose.project=${PROJECT}`;
  const down = `docker compose -f ${FILE} -p ${PROJECT} down -v --remove-orphans -t 5`;
  const confirm = async (replies: Reply[]) => {
    const calls: string[] = [];
    const check = await confirmTeardown({
      run: fakeRunner(replies, calls),
      composeFile: FILE,
      project: PROJECT,
    });
    return { check, calls };
  };

  const empty = await confirm([{ code: 0, stdout: "" }]);
  assert.deepEqual(empty, { check: { isConfirmed: true }, calls: [ps] });
  const stuck = await confirm([
    { code: 0, stdout: "c1\n" },
    { code: 1, stdout: "" },
    { code: 0, stdout: "c1\n" },
  ]);
  assert.deepEqual(stuck, {
    check: { isConfirmed: false, reason: "1 containers remain after compose down (exit 1)" },
    calls: [ps, down, ps],
  });
  const cleared = await confirm([
    { code: 0, stdout: "c1\n" },
    { code: 0, stdout: "" },
    { code: 0, stdout: "" },
  ]);
  assert.deepEqual(cleared, { check: { isConfirmed: true }, calls: [ps, down, ps] });
  const psFails = await confirm([{ code: 1, stdout: "" }]);
  assert.deepEqual(psFails.check, { isConfirmed: false, reason: "docker ps exited with 1" });

  const cleanup = async (id: string, replies: Reply[], failRemove = false) => {
    const calls: string[] = [];
    const removed: string[] = [];
    const lines: string[] = [];
    await cleanupInvocation({
      run: fakeRunner(replies, calls),
      removeDir: async (path) => {
        removed.push(path);
        if (failRemove) throw new Error("busy");
      },
      root,
      id,
      composeFile: FILE,
      log: (line) => lines.push(line),
    });
    return { calls, removed, lines };
  };
  const both = [
    { code: 0, stdout: "" },
    { code: 0, stdout: "" },
  ];
  const done = await cleanup(ID, [...both]);
  const images = done.calls.filter((c) => c.startsWith("docker image rm "));
  assert.deepEqual(
    images,
    ["a", "b"].flatMap((side) =>
      ["api", "probe", "status", "notify"].map(
        (s) => `docker image rm pulse-bench-0a1b2c3d4e5f-${side}-${s}`,
      ),
    ),
  );
  assert.equal(
    done.calls.some((c) => c.includes("oven/bun")),
    false,
  );
  assert.deepEqual(done.removed, [join(root, ".bench", ID)]);
  assert.equal(
    done.calls.some((c) => c.includes(OTHER)),
    false,
    "cleanup never names another run",
  );

  const kept = await cleanup(ID, [
    { code: 0, stdout: "" },
    { code: 0, stdout: "c9\n" },
    { code: 1, stdout: "" },
    { code: 0, stdout: "c9\n" },
  ]);
  assert.equal(
    kept.calls.some((c) => c.startsWith("docker image rm")),
    false,
  );
  assert.deepEqual(kept.removed, []);
  assert.deepEqual(kept.lines, [
    "cleanup skipped: containers of pulse-bench-0a1b2c3d4e5f-b remain; kept .bench/0a1b2c3d4e5f and its images",
  ]);

  const failing = await cleanup(ID, [...both, { code: 1, stdout: "" }], true);
  assert.equal(failing.lines.length, 2, "a failed image rm and a failed removal are logged");
  assert.deepEqual(failing.removed, [join(root, ".bench", ID)]);

  const throwing = await cleanupInvocation({
    run: async () => {
      throw new Error("spawn failed");
    },
    removeDir: async () => undefined,
    root,
    id: ID,
    composeFile: FILE,
    log: () => undefined,
  });
  assert.equal(throwing, undefined, "a command that cannot run is not thrown");

  for (const id of BAD_IDS) {
    const bad = await cleanup(id, []);
    assert.deepEqual([bad.calls, bad.removed], [[], []], `id ${id} sends no command`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("check-invocation: ok");
