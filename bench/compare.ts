// Budgets schema, the failure rule and the summary table. Pure: no I/O.
export const UNITS = ["ms", "s", "MiB", "MB", "req/s"] as const;
export type Unit = (typeof UNITS)[number];

export const METRIC_KEYS = [
  "startup_cpu_ms",
  "load_cpu_s",
  "idle_rss_mib",
  "peak_rss_mib",
  "test_cpu_s",
  "build_cpu_s",
  "startup_wall_ms",
  "p95_get_checks_ms",
  "p95_post_results_ms",
  "rps",
  "image_mb",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface Budget {
  budget: number;
  unit: Unit;
  gating: boolean;
  thresholdPct?: number;
  floor?: number;
}
export type Budgets = Record<string, Record<string, Budget>>;

/** The metrics the harness emits per service. `budgets.json` needs an entry for each. */
export const EMITTED_METRICS: Readonly<Record<string, readonly MetricKey[]>> = {
  api: [
    "startup_cpu_ms",
    "load_cpu_s",
    "idle_rss_mib",
    "peak_rss_mib",
    "test_cpu_s",
    "startup_wall_ms",
    "p95_get_checks_ms",
    "p95_post_results_ms",
    "rps",
    "image_mb",
  ],
  probe: [
    "startup_cpu_ms",
    "load_cpu_s",
    "idle_rss_mib",
    "peak_rss_mib",
    "test_cpu_s",
    "startup_wall_ms",
    "image_mb",
  ],
  status: [
    "startup_cpu_ms",
    "load_cpu_s",
    "idle_rss_mib",
    "peak_rss_mib",
    "test_cpu_s",
    "startup_wall_ms",
    "image_mb",
  ],
  notify: [
    "startup_cpu_ms",
    "load_cpu_s",
    "idle_rss_mib",
    "peak_rss_mib",
    "test_cpu_s",
    "startup_wall_ms",
    "image_mb",
  ],
  contract: ["test_cpu_s", "build_cpu_s"],
  kit: ["test_cpu_s", "build_cpu_s"],
  config: ["test_cpu_s"],
};

export const DEFAULT_THRESHOLD_PCT = 10;
export const DEFAULT_FLOORS: Readonly<Record<string, number>> = { ms: 30, s: 0.2, MiB: 3 };

export type Verdict = "ok" | "FAIL regression" | "FAIL budget" | "reported";

export interface Row {
  service: string;
  metric: string;
  a: number;
  b: number;
  budget: Budget;
  verdict: Verdict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBudget(where: string, value: unknown): Budget {
  if (!isRecord(value)) throw new Error(`${where}: must be an object`);
  const { budget, unit, gating, thresholdPct, floor, ...extra } = value;
  const unknownKey = Object.keys(extra)[0];
  if (unknownKey !== undefined) throw new Error(`${where}: unknown key "${unknownKey}"`);
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
    throw new Error(`${where}.budget: must be a non-negative number`);
  }
  if (typeof unit !== "string" || !(UNITS as readonly string[]).includes(unit)) {
    throw new Error(`${where}.unit: must be one of ${UNITS.join(", ")}`);
  }
  if (typeof gating !== "boolean") throw new Error(`${where}.gating: must be a boolean`);
  const parsed: Budget = { budget, unit: unit as Unit, gating };
  for (const [name, optional] of [
    ["thresholdPct", thresholdPct],
    ["floor", floor],
  ] as const) {
    if (optional === undefined) continue;
    if (typeof optional !== "number" || !Number.isFinite(optional) || optional < 0) {
      throw new Error(`${where}.${name}: must be a non-negative number`);
    }
    parsed[name] = optional;
  }
  return parsed;
}

/** Validate the parsed JSON of `budgets.json` (a trust boundary). */
export function parseBudgets(value: unknown): Budgets {
  if (!isRecord(value)) throw new Error("budgets: must be an object");
  const budgets: Budgets = {};
  for (const [service, metrics] of Object.entries(value)) {
    if (!isRecord(metrics)) throw new Error(`budgets.${service}: must be an object`);
    const parsed: Record<string, Budget> = {};
    for (const [metric, entry] of Object.entries(metrics)) {
      if (!(METRIC_KEYS as readonly string[]).includes(metric)) {
        throw new Error(`budgets.${service}: unknown metric "${metric}"`);
      }
      parsed[metric] = parseBudget(`budgets.${service}.${metric}`, entry);
    }
    budgets[service] = parsed;
  }
  return budgets;
}

/** Every emitted metric needs a budget entry. Returns the missing `service.metric` names. */
export function missingBudgets(
  budgets: Budgets,
  emitted: Readonly<Record<string, readonly string[]>>,
): string[] {
  const missing: string[] = [];
  for (const [service, metrics] of Object.entries(emitted)) {
    for (const metric of metrics) {
      if (budgets[service]?.[metric] === undefined) missing.push(`${service}.${metric}`);
    }
  }
  return missing;
}

/** Verdict of one metric. Lower is better; improvements never fail. */
export function judge(a: number, b: number, budget: Budget): Verdict {
  if (!budget.gating) return "reported";
  const pct = budget.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const floor = budget.floor ?? DEFAULT_FLOORS[budget.unit] ?? 0;
  if (b - a > Math.max((a * pct) / 100, floor)) return "FAIL regression";
  if (b > budget.budget) return "FAIL budget";
  return "ok";
}

export function isFailure(verdict: Verdict): boolean {
  return verdict === "FAIL regression" || verdict === "FAIL budget";
}

function format(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function change(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0%" : "n/a";
  const pct = ((b - a) / a) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** One markdown table per service. A failing row names the metric key. */
export function renderTable(rows: readonly Row[]): string {
  const services = [...new Set(rows.map((r) => r.service))];
  const parts: string[] = [];
  for (const service of services) {
    parts.push(
      `### ${service}`,
      "",
      "| Metric | A | B | Change | Budget | Gating/Reported | Verdict |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const row of rows.filter((r) => r.service === service)) {
      const unit = row.budget.unit;
      parts.push(
        `| \`${row.metric}\` | ${format(row.a)} ${unit} | ${format(row.b)} ${unit} | ${change(row.a, row.b)} | ${format(row.budget.budget)} ${unit} | ${row.budget.gating ? "gating" : "reported"} | ${row.verdict} |`,
      );
    }
    parts.push("");
  }
  return parts.join("\n");
}
