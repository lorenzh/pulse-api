// Self-test of bench port blocks: range parsing, candidate filtering and allocation must pass.
import assert from "node:assert/strict";
import { allocatePorts, candidateBlocks, parseEphemeralRange } from "../ports.ts";

assert.deepEqual(parseEphemeralRange("32768\t60999\n"), { low: 32768, high: 60999 });
for (const text of ["", "abc", "60999 32768", "0 60999", "32768 70000", "1 2 3"]) {
  assert.throws(
    () => parseEphemeralRange(text),
    (err: unknown) => err instanceof Error && err.name === "PortAllocationError",
    `range ${JSON.stringify(text)} must be refused`,
  );
}

assert.equal(candidateBlocks({ low: 32768, high: 60999 }).length, 2000);
const below25000 = candidateBlocks({ low: 25000, high: 60999 });
assert.equal(below25000.includes(999), true);
assert.equal(below25000.includes(1000), false);
assert.equal(below25000.length, 1000);
assert.equal(candidateBlocks({ low: 24998, high: 60999 }).includes(999), false);
assert.throws(
  () => candidateBlocks({ low: 1024, high: 65535 }),
  /^PortAllocationError: no bench port block in 20000-29999 outside the ephemeral range 1024-65535$/,
);

class FakeSockets {
  readonly taken = new Set<number>();
  readonly listens: number[] = [];
  readonly closes: number[] = [];

  listen = async (port: number): Promise<{ close(): Promise<void> } | null> => {
    this.listens.push(port);
    if (this.taken.has(port)) return null;
    this.taken.add(port);
    return {
      close: async () => {
        this.closes.push(port);
        this.taken.delete(port);
      },
    };
  };
}

const blocks = candidateBlocks({ low: 32768, high: 60999 });
const atStart = (): number => 0;

const fresh = new FakeSockets();
const lease0 = await allocatePorts({ listen: fresh.listen, random: atStart }, blocks, []);
assert.equal(lease0.block, 0);
assert.deepEqual(lease0.ports, { api: 20001, probe: 20002, status: 20003, notify: 20004 });
assert.deepEqual(fresh.listens, [20000, 20001, 20002, 20003, 20004]);
assert.deepEqual(fresh.closes, [20001, 20002, 20003, 20004], "probes close at once");
assert.deepEqual([...fresh.taken], [20000], "the guard stays bound");
const second = await allocatePorts({ listen: fresh.listen, random: atStart }, blocks, []);
assert.equal(second.block, 1, "a second allocator with the same start skips the held block");
await lease0.release();
assert.equal(fresh.taken.has(20000), false, "release frees the guard");
const again = await allocatePorts({ listen: fresh.listen, random: atStart }, blocks, []);
assert.equal(again.block, 0);

const guardTaken = new FakeSockets();
guardTaken.taken.add(20000);
assert.equal(
  (await allocatePorts({ listen: guardTaken.listen, random: atStart }, blocks, [])).block,
  1,
);

const statusTaken = new FakeSockets();
statusTaken.taken.add(20003);
const skipped = await allocatePorts({ listen: statusTaken.listen, random: atStart }, blocks, []);
assert.equal(skipped.block, 1);
assert.equal(statusTaken.taken.has(20000), false, "the guard of a skipped block is freed");

const retry = new FakeSockets();
const fromSeven = (): number => 7 / blocks.length;
const excluded = await allocatePorts({ listen: retry.listen, random: fromSeven }, blocks, [7]);
assert.equal(excluded.block, 8, "a failed block is never chosen again");

const wrap = new FakeSockets();
const atEnd = (): number => 1999 / blocks.length;
assert.equal((await allocatePorts({ listen: wrap.listen, random: atEnd }, blocks, [])).block, 1999);
assert.equal((await allocatePorts({ listen: wrap.listen, random: atEnd }, blocks, [])).block, 0);

const full = new FakeSockets();
for (const block of [3, 4, 5]) full.taken.add(20000 + 5 * block);
await assert.rejects(
  allocatePorts({ listen: full.listen, random: () => 0.5 }, [3, 4, 5], []),
  /^PortAllocationError: no free bench port block in 20000-29999$/,
);
assert.deepEqual(
  full.listens.toSorted((x, y) => x - y),
  [20015, 20020, 20025],
  "each block is tried once",
);

console.log("check-ports: ok");
