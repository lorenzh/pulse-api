import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
let dir: string;
let env: Record<string, string>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-main-"));
  writeFileSync(
    join(dir, "checks.json"),
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- plain http literal is a local test fixture
    JSON.stringify({ checks: [{ id: "a", name: "A", url: "http://a/", intervalMs: 1000 }] }),
  );
  writeFileSync(
    join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ location: "eu", token: "test-token-east-0123456789abcdef" }] }),
  );
  env = {
    PATH: process.env.PATH ?? "",
    PORT: "0",
    PULSE_DB: join(dir, "m.db"),
    PULSE_CHECKS_FILE: join(dir, "checks.json"),
    PULSE_TOKENS_FILE: join(dir, "tokens.json"),
  };
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(extra: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], { env: { ...env, ...extra } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exit = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  return { child, exit, out: () => stdout, err: () => stderr };
}

test("a bad setting exits 2 with one line and no stack", async () => {
  const p = run({ PULSE_RETENTION_DAYS: "abc" });
  assert.equal(await p.exit, 2);
  assert.equal(p.err(), "pulse-api: PULSE_RETENTION_DAYS: must be an integer >= 90\n");
});

test("an invalid tokens file exits 2", async () => {
  writeFileSync(join(dir, "bad-tokens.json"), "{}");
  const p = run({ PULSE_TOKENS_FILE: join(dir, "bad-tokens.json") });
  assert.equal(await p.exit, 2);
  assert.match(p.err(), /^pulse-api: .*\n$/);
});

test("SIGTERM stops a running API with exit 0", async () => {
  const p = run({});
  try {
    let hasExited = false;
    void p.exit.then(() => {
      hasExited = true;
    });
    const deadline = Date.now() + 10_000;
    while (!p.out().includes('"listening"')) {
      if (hasExited) assert.fail(`the API exited before it was ready: ${p.err()}`);
      if (Date.now() > deadline) assert.fail("the API was not ready within 10 s");
      await new Promise((r) => setTimeout(r, 20));
    }
    p.child.kill("SIGTERM");
    assert.equal(await p.exit, 0);
    assert.match(p.out(), /"msg":"stopped"/);
  } finally {
    if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
  }
});
