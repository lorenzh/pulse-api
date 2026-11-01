import { test } from "bun:test";
import assert from "node:assert/strict";
import { sha256Hex } from "./token-digest.ts";

test("sha256Hex: lower-case hex SHA-256 of the UTF-8 bytes", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha256Hex("é"), "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
});
