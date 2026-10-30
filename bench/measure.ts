// Measurement helpers: pure parsers for /proc files, the median, and the docker/process readers.
export const CLK_TCK = 100;

/** CPU seconds (utime + stime) from the text of /proc/<pid>/stat. */
export function parseProcStatCpuSeconds(stat: string): number {
  // The command name is in parentheses and may hold spaces: split after the last ")".
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
    throw new Error("cannot parse /proc stat");
  }
  return (utime + stime) / CLK_TCK;
}

/** A kB field of /proc/<pid>/status (`VmRSS`, `VmHWM`) in MiB. */
export function parseStatusMiB(status: string, field: "VmRSS" | "VmHWM"): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(status);
  if (match?.[1] === undefined) throw new Error(`${field} missing in /proc status`);
  return Number(match[1]) / 1024;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  const lower = sorted[mid - 1];
  if (upper === undefined) throw new Error("median of no values");
  if (sorted.length % 2 === 1 || lower === undefined) return upper;
  return (lower + upper) / 2;
}

/** Nearest-rank percentile of a list of numbers, `q` in (0, 1]. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("percentile of no values");
  const sorted = [...values].sort((x, y) => x - y);
  const value = sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  if (value === undefined) throw new Error("percentile of no values");
  return value;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** user + system CPU seconds of the child and its waited descendants. */
  cpuSeconds: number;
}

/** Run a command and collect its output. A non-zero exit code is a result, not a throw. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const usage = proc.resourceUsage();
  const cpuSeconds =
    usage === undefined ? 0 : (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1e6;
  return { code, stdout, stderr, cpuSeconds };
}

/** Like `runCommand`, but a non-zero exit code throws with the tail of stderr. */
export async function runChecked(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.code}: ${result.stderr.slice(-500)}`,
    );
  }
  return result;
}

export interface ProcessSample {
  cpuSeconds: number;
  rssMiB: number;
  peakRssMiB: number;
}

/** Read PID 1 of a container: CPU time, resident and peak resident memory. */
export async function readContainerProcess(container: string): Promise<ProcessSample> {
  const script = "cat /proc/1/stat; echo ---; cat /proc/1/status";
  const { stdout } = await runChecked("docker", ["exec", container, "sh", "-c", script]);
  const [stat, status] = stdout.split("\n---\n");
  if (stat === undefined || status === undefined) throw new Error("bad /proc output");
  return {
    cpuSeconds: parseProcStatCpuSeconds(stat),
    rssMiB: parseStatusMiB(status, "VmRSS"),
    peakRssMiB: parseStatusMiB(status, "VmHWM"),
  };
}
