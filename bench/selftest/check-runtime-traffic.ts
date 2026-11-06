// Self-test of the simulated service traffic: a fake 60 s window, a fake clock and a fake api.
import assert from "node:assert/strict";
import type { Fetch } from "../runtime-fixture.ts";
import {
  checkTrafficCounts,
  startTraffic,
  type TrafficCounts,
  trafficLine,
  trafficSchedule,
} from "../runtime-traffic.ts";

const REVISION = `sha256-${"a".repeat(64)}`;

interface Sent {
  at: number;
  call: string;
}

/** Runs the traffic with timers that fire `lateMs` late; `failAt` answers 500 to that request. */
async function run(lateMs: number, failAt = -1): Promise<{ counts: TrafficCounts; sent: Sent[] }> {
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const call = `${init?.method ?? "GET"} ${path}`;
    sent.push({ at: clock - 1_000_000, call });
    const headers = new Headers(init?.headers);
    assert.match(headers.get("authorization") ?? "", /^Bearer (status|notify)-secret$/);
    if (sent.length - 1 === failAt) return new Response("{}", { status: 500 });
    const etag = `"${REVISION}"`;
    if (headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
    if (path === "/service/status/settings") {
      return Response.json(
        { revision: REVISION, settings: { name: "Bench" } },
        { headers: { etag } },
      );
    }
    if (path === "/service/notify/channels") {
      return Response.json({ revision: REVISION, channels: [] }, { headers: { etag } });
    }
    if (path === "/service/notify/resends/claim") return Response.json({ commands: [] });
    return new Response(null, { status: 204 });
  };
  const traffic = startTraffic({
    apiUrl: "http://api.test",
    side: "b",
    tokens: { status: "status-secret", notify: "notify-secret" },
    fetch,
    now: () => clock,
    wait: async (ms) => {
      clock += ms + lateMs;
    },
  });
  const counts = await traffic.finish();
  return { counts, sent };
}

const EXPECTED: TrafficCounts = {
  statusRead: 4,
  channelRead: 4,
  claim: 12,
  statusReport: 2,
  notifyReport: 2,
};

const onTime = await run(0);
assert.deepEqual(onTime.counts, EXPECTED);
assert.equal(onTime.sent.length, 24);
const at = (call: string): number[] => onTime.sent.filter((s) => s.call === call).map((s) => s.at);
assert.deepEqual(at("GET /service/status/settings"), [0, 15_000, 30_000, 45_000]);
assert.deepEqual(at("GET /service/notify/channels"), [0, 15_000, 30_000, 45_000]);
assert.deepEqual(
  at("POST /service/notify/resends/claim"),
  [0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000, 55_000],
);
assert.deepEqual(at("PUT /service/status/report"), [0, 55_000]);
assert.deepEqual(at("PUT /service/notify/report"), [0, 55_000]);
assert.equal(trafficSchedule().length, 22);
assert.equal(
  trafficLine("b", onTime.counts),
  "service traffic (b): 4 status reads, 4 channel reads, 12 claims, 2 status reports, 2 notify reports",
);

// Timers that fire 4000 ms late still send every request.
const late = await run(4_000);
assert.deepEqual(late.counts, EXPECTED);
assert.equal(late.sent.length, 24);

// One 500 answer fails the run.
await assert.rejects(run(0, 5), /service traffic: .* 500 on b/);

// Wrong counts fail the run.
assert.throws(
  () => checkTrafficCounts("a", { ...EXPECTED, claim: 11 }),
  /^HarnessError: service traffic not observed on a$/,
);
assert.throws(
  () => checkTrafficCounts("b", { ...EXPECTED, notifyReport: 1 }),
  /service traffic not observed on b/,
);
assert.throws(
  () => checkTrafficCounts("b", { ...EXPECTED, statusReport: 1, notifyReport: 1 }),
  /service traffic not observed on b/,
);
checkTrafficCounts("b", EXPECTED);

console.log("check-runtime-traffic: ok");
