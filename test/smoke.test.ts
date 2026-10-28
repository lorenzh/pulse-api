import { test } from "node:test";
import assert from "node:assert/strict";
import * as pkg from "../src/index.ts";

test("smoke: index module loads", () => {
  assert.equal(typeof pkg, "object");
});
