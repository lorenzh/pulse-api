// Self-test of the /proc parsers, the median and the percentile.
import assert from "node:assert/strict";
import { median, parseProcStatCpuSeconds, parseStatusMiB, percentile } from "../measure.ts";

const stat = "1 (bun run) S 0 1 1 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 8 0 100 1000 1000 0";
assert.equal(parseProcStatCpuSeconds(stat), 2);
assert.throws(() => parseProcStatCpuSeconds("1 (x) S"), /cannot parse/);

const status = "Name:\tbun\nVmHWM:\t  204800 kB\nVmRSS:\t  102400 kB\n";
assert.equal(parseStatusMiB(status, "VmRSS"), 100);
assert.equal(parseStatusMiB(status, "VmHWM"), 200);
assert.throws(() => parseStatusMiB("Name:\tbun\n", "VmRSS"), /VmRSS missing/);

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.throws(() => median([]), /no values/);
assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
console.log("check-measure: ok");
