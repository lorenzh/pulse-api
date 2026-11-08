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
  reloadNow(): void;
  revision(): string;
  lines: string[];
  results: ConfigReloadResult[];
  reads: () => number;
  applies: () => number;
}

interface SetupOpts {
  bytes?: Buffer;
  readError?: Error;
  failures?: unknown[];
  revision?: string;
  stampKey?: string;
}

function setup(opts: SetupOpts): Harness {
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
      now: () => 0,
      onApply: (_config: Config) => {
        applies += 1;
        if (failures.length > 0) throw failures.shift();
      },
      log: (line) => lines.push(line),
      metrics: { recordConfigReload: (r) => results.push(r) },
    },
    {
      config: parseConfigText(PATH, VALID.toString("utf8")),
      revision: opts.revision ?? INITIAL,
      stampKey: opts.stampKey ?? "old",
    },
  );
  return {
    poll: () => reloader.poll(),
    reloadNow: () => reloader.reloadNow(),
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

test("a failed forced apply of unchanged bytes is retried on the next poll", () => {
  const h = setup({
    failures: [new Error("boom")],
    revision: revisionOf(VALID),
    stampKey: "2:10:1",
  });
  h.reloadNow();
  assert.equal(h.applies(), 1);
  assert.deepEqual(h.results, ["error"]);

  h.poll();
  assert.equal(h.applies(), 2);
  assert.deepEqual(h.results, ["error", "ok"]);

  h.poll();
  assert.equal(h.applies(), 2);
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

test("a read failure is rejected and counted once, while it is read again at every poll", () => {
  const err = Object.assign(new Error("denied"), { code: "EACCES" });
  const h = setup({ readError: err });
  h.poll();
  h.poll();
  assert.deepEqual(h.lines, [`config reload rejected: ${PATH}: cannot read the file (EACCES)`]);
  assert.deepEqual(h.results, ["invalid"]);
  assert.equal(h.reads(), 2);
});

test("an unreadable file under an unchanged stamp is applied once it is readable again", () => {
  const cases = [
    { name: "unreadable at start (fallback)", isUnreadableAtStart: true },
    { name: "unreadable at a poll", isUnreadableAtStart: false },
  ];
  for (const c of cases) {
    let isDenied = true;
    const results: ConfigReloadResult[] = [];
    const reloader = createConfigReloader(
      {
        path: PATH,
        fs: {
          // A chmod changes neither mtime, size nor inode.
          stat: () => STAMP,
          readFile: () => {
            if (isDenied) throw Object.assign(new Error("denied"), { code: "EACCES" });
            return VALID;
          },
        },
        now: () => 5000,
        onApply: () => undefined,
        log: () => undefined,
        metrics: { recordConfigReload: (r) => results.push(r) },
      },
      {
        config: parseConfigText(PATH, VALID.toString("utf8")),
        revision: INITIAL,
        stampKey: c.isUnreadableAtStart ? "2:10:1" : "old",
        appliedAt: 1000,
        ...(c.isUnreadableAtStart
          ? { status: { state: "unreadable" as const, message: "cannot read the file (EACCES)" } }
          : {}),
      },
    );
    reloader.poll();
    assert.equal(reloader.fileStatus().state, "unreadable", c.name);
    isDenied = false;
    reloader.poll();
    assert.deepEqual(
      reloader.fileStatus(),
      { state: "ok", message: null, lastAppliedAt: 5000 },
      c.name,
    );
    assert.equal(reloader.revision(), revisionOf(VALID), c.name);
  }
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

const REJECT_URL =
  "config reload rejected: /etc/pulse/checks.json: checks[0].url: must be an http: or https: URL";
const REJECT_INTERVAL =
  "config reload rejected: /etc/pulse/checks.json: checks[0].intervalMs must be an integer from 1 to 2147483647 (milliseconds)";

function fileWith(url: string, intervalMs: number): Buffer {
  return Buffer.from(JSON.stringify({ checks: [{ id: "x", name: "X", url, intervalMs }] }));
}

interface FakeFile {
  bytes: Buffer;
  stamp: FileStamp;
  readError?: Error;
}

function setupFile(file: FakeFile): Harness {
  const lines: string[] = [];
  const results: ConfigReloadResult[] = [];
  let reads = 0;
  let applies = 0;
  const reloader = createConfigReloader(
    {
      path: PATH,
      fs: {
        stat: () => file.stamp,
        readFile: () => {
          reads += 1;
          if (file.readError) throw file.readError;
          return file.bytes;
        },
      },
      now: () => 0,
      onApply: () => {
        applies += 1;
      },
      log: (line) => lines.push(line),
      metrics: { recordConfigReload: (r) => results.push(r) },
    },
    { config: parseConfigText(PATH, VALID.toString("utf8")), revision: INITIAL, stampKey: "old" },
  );
  return {
    poll: () => reloader.poll(),
    reloadNow: () => reloader.reloadNow(),
    revision: () => reloader.revision(),
    lines,
    results,
    reads: () => reads,
    applies: () => applies,
  };
}

test("poll and forced reloads share one warning line, also for new bytes with the same message", () => {
  const file: FakeFile = { bytes: fileWith("file:///x", 60000), stamp: STAMP };
  const h = setupFile(file);
  h.poll();
  h.reloadNow();
  h.reloadNow();
  assert.deepEqual(h.lines, [REJECT_URL]);
  assert.deepEqual(h.results, ["invalid"]);
  assert.equal(h.revision(), INITIAL);
  assert.equal(h.applies(), 0);

  file.bytes = fileWith("file:///y", 60000);
  file.stamp = { mtimeMs: 3, size: 11, ino: 1 };
  h.poll();
  h.reloadNow();
  assert.deepEqual(h.lines, [REJECT_URL]);
  assert.deepEqual(h.results, ["invalid"]);
});

test("a forced reload logs another message, and the same message again after a valid apply", () => {
  const file: FakeFile = { bytes: fileWith("file:///x", 60000), stamp: STAMP };
  const h = setupFile(file);
  h.poll();
  assert.deepEqual(h.lines, [REJECT_URL]);

  file.bytes = fileWith("http://localhost:1/", 0);
  h.reloadNow();
  assert.deepEqual(h.lines, [REJECT_URL, REJECT_INTERVAL]);
  assert.deepEqual(h.results, ["invalid", "invalid"]);

  file.bytes = VALID;
  h.reloadNow();
  assert.deepEqual(h.results, ["invalid", "invalid", "ok"]);

  file.bytes = fileWith("file:///x", 60000);
  h.reloadNow();
  assert.deepEqual(h.lines, [REJECT_URL, REJECT_INTERVAL, REJECT_URL]);
  assert.deepEqual(h.results, ["invalid", "invalid", "ok", "invalid"]);
  assert.equal(h.applies(), 1);
});

test("an unreadable file is logged once across poll and forced reloads, and read every time", () => {
  const readError = Object.assign(new Error("SENTINEL-READ-MESSAGE"), { code: "EACCES" });
  const h = setupFile({ bytes: VALID, stamp: STAMP, readError });
  h.poll();
  h.reloadNow();
  h.reloadNow();
  assert.deepEqual(h.lines, [
    `config reload rejected: /etc/pulse/checks.json: cannot read the file (EACCES)`,
  ]);
  assert.deepEqual(h.results, ["invalid"]);
  assert.equal(h.reads(), 3);
  for (const line of h.lines) assert.ok(!line.includes("SENTINEL-READ-MESSAGE"), line);
});
