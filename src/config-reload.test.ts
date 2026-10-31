import { test } from "bun:test";
import assert from "node:assert/strict";
import { type Config, parseConfigText } from "./config.ts";
import { createConfigReloader, type FileStamp, revisionOf } from "./config-reload.ts";
import type { ConfigReloadResult } from "./metrics.ts";

const PATH = "/etc/pulse/checks.json";
const HEADER = "SENTINEL-HEADER-VALUE";
const SECRET = "SENTINEL-HEARTBEAT-SECRET-0123456789";
const INITIAL = "sha256-initial";
const STAMP: FileStamp = { mtimeMs: 2, size: 10, ino: 1 };

const VALID = Buffer.from(
  JSON.stringify({
    checks: [
      {
        id: "web",
        name: "Web",
        url: "https://web.example/",
        intervalMs: 60000,
        headers: { "x-key": HEADER },
      },
      {
        id: "nightly",
        name: "Nightly",
        type: "heartbeat",
        period: 60000,
        grace: 0,
        secret: SECRET,
      },
    ],
  }),
);
const INVALID = Buffer.from(
  JSON.stringify({ checks: [{ id: "x", name: "X", url: "file:///x", intervalMs: 60000 }] }),
);

interface Harness {
  poll(): void;
  revision(): string;
  lines: string[];
  results: ConfigReloadResult[];
  reads: () => number;
  applies: () => number;
}

function setup(opts: { bytes?: Buffer; readError?: Error; failures?: unknown[] }): Harness {
  const lines: string[] = [];
  const results: ConfigReloadResult[] = [];
  const failures = [...(opts.failures ?? [])];
  let reads = 0;
  let applies = 0;
  const reloader = createConfigReloader(
    {
      path: PATH,
      fs: {
        stat: () => STAMP,
        readFile: () => {
          reads += 1;
          if (opts.readError) throw opts.readError;
          return opts.bytes ?? VALID;
        },
      },
      onApply: (_config: Config) => {
        applies += 1;
        if (failures.length > 0) throw failures.shift();
      },
      log: (line) => lines.push(line),
      metrics: { recordConfigReload: (r) => results.push(r) },
    },
    {
      config: parseConfigText(PATH, VALID.toString("utf8")),
      revision: INITIAL,
      stampKey: "old",
    },
  );
  return {
    poll: () => reloader.poll(),
    revision: () => reloader.revision(),
    lines,
    results,
    reads: () => reads,
    applies: () => applies,
  };
}

test("a failed apply is logged at warn without the message, counted as error and retried", () => {
  const h = setup({ failures: [new Error("SQLITE_BUSY: database is locked")] });
  h.poll();
  assert.deepEqual(h.lines, [
    `config reload failed: ${PATH}: cannot apply the configuration: Error`,
  ]);
  assert.deepEqual(h.results, ["error"]);
  assert.equal(h.revision(), INITIAL);

  h.poll();
  assert.equal(h.applies(), 2);
  assert.deepEqual(h.results, ["error", "ok"]);
  assert.equal(h.revision(), revisionOf(VALID));
  assert.equal(h.lines.length, 1);

  const reads = h.reads();
  h.poll();
  assert.equal(h.reads(), reads);
});

test("an invalid file is rejected once per stamp", () => {
  const h = setup({ bytes: INVALID });
  h.poll();
  h.poll();
  h.poll();
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0] ?? "", /^config reload rejected: /);
  assert.deepEqual(h.results, ["invalid"]);
});

test("a read failure is rejected once and read once per stamp", () => {
  const err = Object.assign(new Error("denied"), { code: "EACCES" });
  const h = setup({ readError: err });
  h.poll();
  h.poll();
  assert.deepEqual(h.lines, [`config reload rejected: ${PATH}: cannot read the file (EACCES)`]);
  assert.deepEqual(h.results, ["invalid"]);
  assert.equal(h.reads(), 1);
});

test("the failure line holds name and safe code only, never the message", () => {
  const leaky = Object.assign(new Error(`bad ${HEADER}\n${SECRET}`), {
    code: "SQLITE_CONSTRAINT_CHECK",
  });
  const badCode = Object.assign(new Error(HEADER), { code: "bad code\n" });
  const badName = new Error(HEADER);
  badName.name = `X ${SECRET}`;
  const h = setup({ failures: [leaky, badCode, "x", badName] });
  for (let i = 0; i < 4; i++) h.poll();
  const prefix = `config reload failed: ${PATH}: cannot apply the configuration: `;
  assert.deepEqual(h.lines, [
    `${prefix}Error SQLITE_CONSTRAINT_CHECK`,
    `${prefix}Error`,
    `${prefix}unknown error`,
    `${prefix}Error`,
  ]);
  for (const line of h.lines) {
    assert.ok(!line.includes(HEADER) && !line.includes(SECRET) && !line.includes("\n"), line);
  }
  assert.deepEqual(h.results, ["error", "error", "error", "error"]);
});
