import type { AdminConfigExport, AdminExportRedaction, Check } from "@lorenzh/pulse-contract";
import type { Config } from "./config.ts";

type ExportCheck = AdminConfigExport["checks"][number];

/**
 * The check as a checks file entry: `{ env }` headers stay; literal headers, the body and the
 * heartbeat secret (never part of a parsed check) are left out and listed in `redacted`.
 */
function exportCheck(check: Check, redacted: AdminExportRedaction[]): ExportCheck {
  const checkId = check.id;
  switch (check.type) {
    case "heartbeat":
      redacted.push({ checkId, field: "secret" });
      return { ...check };
    case "tls":
    case "tcp":
    case "dns":
    case "domain":
      return { ...check };
    case undefined:
    case "http": {
      const { headers, body, ...rest } = check;
      const keptEntries: [string, { env: string }][] = [];
      for (const [name, value] of Object.entries(headers ?? {})) {
        if (typeof value === "string") redacted.push({ checkId, field: `headers.${name}` });
        else keptEntries.push([name, { env: value.env }]);
      }
      // fromEntries defines own keys; plain assignment would run the `__proto__` setter.
      const kept = Object.fromEntries(keptEntries);
      if (body !== undefined) redacted.push({ checkId, field: "body" });
      return { ...rest, ...(Object.keys(kept).length > 0 ? { headers: kept } : {}) };
    }
    default: {
      const never: never = check;
      return never;
    }
  }
}

/**
 * The export document of the configuration in use: the effective checks in effective order, the
 * applied file's components and windows (ISO 8601 UTC), and `redacted` only when a value was left
 * out. Shadowed definitions are not part of the effective set, so they are never exported.
 */
export function configExport(config: Omit<Config, "secrets">): AdminConfigExport {
  const redacted: AdminExportRedaction[] = [];
  const checks = config.checks.map((check) => exportCheck(check, redacted));
  return {
    checks,
    components: config.components.map((c) => ({ ...c })),
    maintenance: config.maintenance.map(({ checkId, start, end, note }) => ({
      checkId,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      note,
    })),
    ...(redacted.length > 0 ? { redacted } : {}),
  };
}

/** The response bytes: JSON with two spaces and a final newline, the checks file format. */
export function exportBytes(document: AdminConfigExport): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
