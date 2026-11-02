import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfigFs } from "./config-fs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-config-fs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const codeOf = (fn: () => void): unknown => {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? Reflect.get(err, "code") : undefined;
  }
  return undefined;
};

test("writeTemp keeps the mode of the checks file and is exclusive", () => {
  const like = join(dir, "checks.json");
  writeFileSync(like, "{}");
  chmodSync(like, 0o640);
  const temp = join(dir, "checks.json.x.tmp");
  nodeConfigFs.writeTemp(temp, Buffer.from("new"), like);
  expect(readFileSync(temp, "utf8")).toBe("new");
  expect(statSync(temp).mode & 0o777).toBe(0o640);
  expect(codeOf(() => nodeConfigFs.writeTemp(temp, Buffer.from("x"), like))).toBe("EEXIST");
  expect(readFileSync(temp, "utf8")).toBe("new");
});

test("writeTemp without a checks file uses mode 600; lstat, rename, remove and fsyncDir work", () => {
  const temp = join(dir, "a.tmp");
  nodeConfigFs.writeTemp(temp, Buffer.from("a"), join(dir, "missing.json"));
  expect(statSync(temp).mode & 0o777).toBe(0o600);
  nodeConfigFs.fsyncDir(dir);
  nodeConfigFs.lstat(temp);
  const target = join(dir, "b.json");
  nodeConfigFs.rename(temp, target);
  expect(codeOf(() => nodeConfigFs.lstat(temp))).toBe("ENOENT");
  nodeConfigFs.remove(target);
  expect(codeOf(() => nodeConfigFs.lstat(target))).toBe("ENOENT");
});

test("writeTemp removes its file when a later step fails", () => {
  // A `like` path below a regular file fails its stat with ENOTDIR after the create.
  const blocker = join(dir, "file");
  writeFileSync(blocker, "x");
  const temp = join(dir, "c.tmp");
  expect(codeOf(() => nodeConfigFs.writeTemp(temp, Buffer.from("c"), join(blocker, "x")))).toBe(
    "ENOTDIR",
  );
  expect(codeOf(() => nodeConfigFs.lstat(temp))).toBe("ENOENT");
});
