// Writes the demo checks file with maintenance windows relative to the start time.
import { writeFileSync } from "node:fs";

const MINUTE = 60_000;
const now = Date.now();
const iso = (offsetMinutes) => new Date(now + offsetMinutes * MINUTE).toISOString();
const targets = "http://demo-targets:8000";

const http = (id, name, path, extra = {}) => ({
  id,
  name,
  url: `${targets}${path}`,
  intervalMs: 5000,
  timeoutMs: 3000,
  retries: 0,
  ...extra,
});

const config = {
  checks: [
    http("always-healthy", "Always healthy", "/up"),
    http("slow-endpoint", "Slow endpoint", "/slow", { latencyObjectiveMs: 500 }),
    http("flaky-service", "Flaky service", "/flaky"),
    http("database-upgrade", "Database upgrade", "/maintenance"),
    http("scheduled-upgrade", "Scheduled upgrade", "/up"),
    {
      id: "tls-certificate",
      name: "TLS certificate",
      type: "tls",
      host: "demo-tls",
      port: 8443,
      warnDays: 3,
      intervalMs: 10000,
    },
  ],
  maintenance: [
    {
      checkId: "database-upgrade",
      start: iso(-1),
      end: iso(15),
      note: "Database upgrade in progress",
    },
    {
      checkId: "scheduled-upgrade",
      start: iso(30),
      end: iso(90),
      note: "Planned upgrade window",
    },
  ],
};

writeFileSync("/shared/checks.json", `${JSON.stringify(config, null, 2)}\n`);
console.log("demo-init: wrote /shared/checks.json");
