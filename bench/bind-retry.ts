// One retry of a bench phase after a host port bind failure, and teardown checks before reuse.
import type { EodPhase } from "./eod.ts";
import type { TeardownCheck } from "./invocation.ts";
import { CommandExitError } from "./measure.ts";
import type { PortLease } from "./ports.ts";

const BIND_ATTEMPTS = 2;
const BIND_TEXT = /address already in use|port is already allocated/i;
const MAX_LINE = 300;
const MAX_CAUSES = 10;

class PortBindError extends Error {
  override readonly name = "PortBindError";
}

class TeardownError extends Error {
  override readonly name = "TeardownError";
}

/** The first stderr line of a Docker bind failure in `err` or its causes, else undefined. */
function isPortBindFailure(err: unknown): string | undefined {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSES && current instanceof Error; depth++) {
    if (current instanceof CommandExitError && current.command === "docker") {
      const line = current.stderr.split("\n").find((l) => BIND_TEXT.test(l));
      if (line !== undefined) return line.trim().slice(0, MAX_LINE);
    }
    current = current.cause;
  }
  return undefined;
}

const teardownText = (phase: string, side: string, project: string, reason: string): string =>
  `teardown not confirmed: ${phase} on ${side} (project ${project}): ${reason}`;

export interface BindRetryDeps<T> {
  phase: "load" | "cold" | "eod";
  side: string;
  project: string;
  /** The usual failure log of the side and round. */
  failureLogFile: string;
  /** Where attempt 1 dumps its stack; kept under this name only when a retry follows. */
  attempt1LogFile: string;
  allocate(exclude: readonly number[]): Promise<PortLease>;
  removeRunDir(): Promise<void>;
  attempt(lease: PortLease, failureLogFile: string): Promise<T>;
  confirmTeardown(): Promise<TeardownCheck>;
  moveFailureLog(from: string, to: string): Promise<void>;
  log(line: string): void;
}

type Outcome<T> =
  | { isOk: true; value: T; lease: PortLease }
  | { isOk: false; error: unknown; lease: PortLease; isConfirmed: boolean };

async function runAttempt<T>(
  deps: BindRetryDeps<T>,
  exclude: readonly number[],
  logFile: string,
): Promise<Outcome<T>> {
  const lease = await deps.allocate(exclude);
  let outcome: { isOk: true; value: T } | { isOk: false; error: unknown };
  try {
    await deps.removeRunDir();
    outcome = { isOk: true, value: await deps.attempt(lease, logFile) };
  } catch (error) {
    outcome = { isOk: false, error };
  }
  const check = await deps.confirmTeardown();
  if (check.isConfirmed) {
    await lease.release();
  } else {
    deps.log(teardownText(deps.phase, deps.side, deps.project, check.reason));
    // The guard stays bound and the run directory stays until the process exits.
    if (outcome.isOk) {
      throw new TeardownError(teardownText(deps.phase, deps.side, deps.project, check.reason));
    }
  }
  return outcome.isOk
    ? { isOk: true, value: outcome.value, lease }
    : { isOk: false, error: outcome.error, lease, isConfirmed: check.isConfirmed };
}

const where = (phase: string, side: string, lease: PortLease): string => {
  const { api, probe, status, notify } = lease.ports;
  return `${phase} on ${side} (ports ${api},${probe},${status},${notify})`;
};

function lastAttemptError<T>(deps: BindRetryDeps<T>, error: unknown, lease: PortLease): unknown {
  const line = isPortBindFailure(error);
  if (line === undefined) return error;
  return new PortBindError(
    `host port bind failed twice: ${where(deps.phase, deps.side, lease)}: ${line}`,
    { cause: error },
  );
}

/** The error that ends the phase after attempt 1, or undefined when a retry follows. */
async function firstAttemptError<T>(
  deps: BindRetryDeps<T>,
  result: { error: unknown; lease: PortLease; isConfirmed: boolean },
): Promise<{ error: unknown } | undefined> {
  const line = isPortBindFailure(result.error);
  if (line !== undefined && result.isConfirmed) return undefined;
  await deps.moveFailureLog(deps.attempt1LogFile, deps.failureLogFile);
  if (line === undefined) return { error: result.error };
  const error = new PortBindError(
    `host port bind failed, retry skipped because teardown was not confirmed: ${where(deps.phase, deps.side, result.lease)}: ${line}`,
    { cause: result.error },
  );
  return { error };
}

/**
 * Runs one phase of one side and round. A host port bind failure gets one more attempt on new
 * ports, after its teardown is confirmed; every other failure is rethrown.
 */
export async function withBindRetry<T>(deps: BindRetryDeps<T>): Promise<T> {
  const failed: number[] = [];
  for (let attempt = 1; attempt <= BIND_ATTEMPTS; attempt++) {
    const isLast = attempt === BIND_ATTEMPTS;
    const logFile = isLast ? deps.failureLogFile : deps.attempt1LogFile;
    const result = await runAttempt(deps, failed, logFile);
    if (result.isOk) return result.value;
    if (isLast) throw lastAttemptError(deps, result.error, result.lease);
    const stop = await firstAttemptError(deps, result);
    if (stop !== undefined) throw stop.error;
    deps.log(
      `bind retry: ${deps.phase} on ${deps.side}: host port in use, retrying once with new ports`,
    );
    failed.push(result.lease.block);
  }
  throw new Error("unreachable: the attempt loop always returns or throws");
}

/** Confirms the teardown of `project` before every seed of the end-of-day phase. */
export function withConfirmedReseed(
  phase: EodPhase,
  options: { confirmTeardown: () => Promise<TeardownCheck>; side: string; project: string },
): EodPhase {
  return {
    seed: async (now) => {
      const check = await options.confirmTeardown();
      if (!check.isConfirmed) {
        throw new TeardownError(teardownText("eod", options.side, options.project, check.reason));
      }
      return phase.seed(now);
    },
    measure: () => phase.measure(),
  };
}
