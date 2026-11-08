// Self-test of CommandExitError: runChecked keeps the full stderr and shows only its last 500 characters.
import assert from "node:assert/strict";
import { runChecked } from "../measure.ts";

const bindLine = "Bind for 127.0.0.1:20001 failed: port is already allocated";
const script = `printf '%s\\n' '${bindLine}' >&2; printf 'x%.0s' $(seq 600) >&2; exit 1`;
const args = ["-c", script];

let caught: unknown;
try {
  await runChecked("sh", args);
} catch (err) {
  caught = err;
}
assert.ok(caught instanceof Error, "runChecked must throw on exit 1");
const stderr: unknown = Reflect.get(caught, "stderr");
assert.ok(
  typeof stderr === "string" && stderr.includes(bindLine),
  "the error must keep the full stderr with the bind line",
);
assert.equal(stderr, `${bindLine}\n${"x".repeat(600)}`);
assert.equal(caught.name, "CommandExitError");
assert.equal(Reflect.get(caught, "command"), "sh");
assert.deepEqual(Reflect.get(caught, "args"), args);
assert.equal(Reflect.get(caught, "code"), 1);
assert.equal(caught.message, `sh ${args.join(" ")} exited with 1: ${"x".repeat(500)}`);
console.log("check-command-error: ok");
