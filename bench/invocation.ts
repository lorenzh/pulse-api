// The identity of one bench run: its id, project and image names, workspace, teardown and cleanup.
import { dirname, resolve } from "node:path";
import type { ServicePorts } from "./ports.ts";

const ID_PATTERN = /^[0-9a-f]{12}$/;
const SIDES = ["a", "b"] as const;
const IMAGE_SERVICES = ["api", "probe", "status", "notify"] as const;

class InvalidInvocationIdError extends Error {
  override readonly name = "InvalidInvocationIdError";
}

/** The result of `confirmTeardown`. */
export type TeardownCheck = { isConfirmed: true } | { isConfirmed: false; reason: string };

interface CommandOutcome {
  code: number;
  stdout: string;
}

type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandOutcome>;

/** 12 lowercase hex characters from 6 random bytes. */
export function newInvocationId(randomBytes: (size: number) => Uint8Array): string {
  return Array.from(randomBytes(6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function benchProject(id: string, side: "a" | "b"): string {
  return `pulse-bench-${id}-${side}`;
}

export function benchImage(project: string, service: string): string {
  return `${project}-${service}`;
}

/** The host ports of a stack as the variables of `compose.bench.yaml`. */
export function portEnv(ports: ServicePorts): Record<string, string> {
  return {
    BENCH_API_PORT: String(ports.api),
    BENCH_PROBE_PORT: String(ports.probe),
    BENCH_STATUS_PORT: String(ports.status),
    BENCH_NOTIFY_PORT: String(ports.notify),
  };
}

/** `<root>/.bench/<id>`; throws on a malformed id or a path outside `<root>/.bench`. */
export function workspaceDir(root: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new InvalidInvocationIdError("invalid invocation id");
  const base = resolve(root, ".bench");
  const dir = resolve(base, id);
  if (dirname(dir) !== base) throw new InvalidInvocationIdError("invalid invocation id");
  return dir;
}

async function listContainers(
  run: CommandRunner,
  project: string,
): Promise<{ count: number } | { reason: string }> {
  const filter = `label=com.docker.compose.project=${project}`;
  const ps = await run("docker", ["ps", "-a", "-q", "--filter", filter]);
  if (ps.code !== 0) return { reason: `docker ps exited with ${ps.code}` };
  return { count: ps.stdout.split("\n").filter((line) => line.trim() !== "").length };
}

async function confirmOnce(
  run: CommandRunner,
  composeFile: string,
  project: string,
): Promise<TeardownCheck> {
  const before = await listContainers(run, project);
  if ("reason" in before) return { isConfirmed: false, reason: before.reason };
  if (before.count === 0) return { isConfirmed: true };
  const down = await run("docker", [
    ...["compose", "-f", composeFile, "-p", project],
    ...["down", "-v", "--remove-orphans", "-t", "5"],
  ]);
  const after = await listContainers(run, project);
  if ("reason" in after) return { isConfirmed: false, reason: after.reason };
  if (after.count === 0) return { isConfirmed: true };
  return {
    isConfirmed: false,
    reason: `${after.count} containers remain after compose down (exit ${down.code})`,
  };
}

/** Confirms that no container of `project` is left, running `compose down` once more if needed. */
export async function confirmTeardown(deps: {
  run: CommandRunner;
  composeFile: string;
  project: string;
}): Promise<TeardownCheck> {
  try {
    return await confirmOnce(deps.run, deps.composeFile, deps.project);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown error";
    return { isConfirmed: false, reason: `docker could not run (${name})` };
  }
}

interface CleanupDeps {
  run: CommandRunner;
  removeDir(path: string): Promise<void>;
  root: string;
  id: string;
  composeFile: string;
  log(line: string): void;
}

async function removeImage(deps: CleanupDeps, image: string): Promise<void> {
  try {
    const result = await deps.run("docker", ["image", "rm", image]);
    if (result.code !== 0) deps.log(`cleanup: docker image rm ${image} exited with ${result.code}`);
  } catch (err) {
    deps.log(`cleanup: docker image rm ${image} failed: ${err instanceof Error ? err.name : err}`);
  }
}

/**
 * Removes the run's eight images and its workspace, only after both side projects are confirmed
 * torn down. Never throws: a failure is logged.
 */
export async function cleanupInvocation(deps: CleanupDeps): Promise<void> {
  let dir: string;
  try {
    dir = workspaceDir(deps.root, deps.id);
  } catch {
    // The id is the only input: a bad one means nothing of this run can be named safely.
    deps.log("cleanup skipped: invalid invocation id");
    return;
  }
  for (const side of SIDES) {
    const project = benchProject(deps.id, side);
    const check = await confirmTeardown({ run: deps.run, composeFile: deps.composeFile, project });
    if (!check.isConfirmed) {
      deps.log(
        `cleanup skipped: containers of ${project} remain; kept .bench/${deps.id} and its images`,
      );
      return;
    }
  }
  for (const side of SIDES) {
    for (const service of IMAGE_SERVICES) {
      await removeImage(deps, benchImage(benchProject(deps.id, side), service));
    }
  }
  try {
    await deps.removeDir(dir);
  } catch (err) {
    deps.log(
      `cleanup: could not remove .bench/${deps.id}: ${err instanceof Error ? err.name : err}`,
    );
  }
}
