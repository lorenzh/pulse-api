// The simulated status and notify traffic of procedure 2 (spec of #570), sent from the harness
// during the 60 s load window. `fetch`, the clock and the wait are injected.
import {
  validateResendClaimResponse,
  validateServiceNotifyChannels,
  validateServiceStatusSettings,
} from "@lorenzh/pulse-contract";
import { type Fetch, HarnessError, type ServiceTokens, type Side } from "./runtime-fixture.ts";

export type TrafficKind = "statusRead" | "channelRead" | "claim" | "statusReport" | "notifyReport";
export type TrafficCounts = Record<TrafficKind, number>;

/** The counts every side with the simulation must observe (literals of procedure 2). */
export const EXPECTED_COUNTS: TrafficCounts = {
  statusRead: 4,
  channelRead: 4,
  claim: 12,
  statusReport: 2,
  notifyReport: 2,
};

const READ_EVERY_MS = 15_000;
const CLAIM_EVERY_MS = 5_000;
const WINDOW_MS = 60_000;

/** The timed part of the schedule, in ms from the window start; reports at 0 are included. */
export function trafficSchedule(): { at: number; kind: TrafficKind }[] {
  const items: { at: number; kind: TrafficKind }[] = [
    { at: 0, kind: "statusReport" },
    { at: 0, kind: "notifyReport" },
  ];
  for (let at = 0; at < WINDOW_MS; at += READ_EVERY_MS) {
    items.push({ at, kind: "statusRead" }, { at, kind: "channelRead" });
  }
  for (let at = 0; at < WINDOW_MS; at += CLAIM_EVERY_MS) items.push({ at, kind: "claim" });
  return items.sort((x, y) => x.at - y.at);
}

export function trafficLine(side: Side, c: TrafficCounts): string {
  return `service traffic (${side}): ${c.statusRead} status reads, ${c.channelRead} channel reads, ${c.claim} claims, ${c.statusReport} status reports, ${c.notifyReport} notify reports`;
}

/** Throws unless the counts are exactly the expected ones. */
export function checkTrafficCounts(side: Side, counts: TrafficCounts): void {
  for (const kind of Object.keys(EXPECTED_COUNTS) as TrafficKind[]) {
    if (counts[kind] !== EXPECTED_COUNTS[kind]) {
      throw new HarnessError(`service traffic not observed on ${side}`);
    }
  }
}

export interface TrafficDeps {
  apiUrl: string;
  side: Side;
  tokens: ServiceTokens;
  fetch: Fetch;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

export interface Traffic {
  /** Waits for the timed requests, sends the final reports and checks the counts. */
  finish: () => Promise<TrafficCounts>;
}

const OK = new Set([200, 204, 304]);

function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, connection: "close", ...extra };
}

function parseOrFail(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HarnessError(`service traffic: ${label} answered no JSON`, { cause: err });
  }
}

/** Starts the traffic at the window start (`now()` at the call is t = 0). */
export function startTraffic(deps: TrafficDeps): Traffic {
  const counts: TrafficCounts = {
    statusRead: 0,
    channelRead: 0,
    claim: 0,
    statusReport: 0,
    notifyReport: 0,
  };
  const etags: { status: string | null; notify: string | null } = { status: null, notify: null };
  const revisions: { status: string | null; notify: string | null } = {
    status: null,
    notify: null,
  };
  const start = deps.now();

  const call = async (kind: TrafficKind, path: string, init: RequestInit): Promise<Response> => {
    const response = await deps.fetch(`${deps.apiUrl}${path}`, init);
    if (!OK.has(response.status)) {
      await response.arrayBuffer();
      throw new HarnessError(`service traffic: ${kind} ${response.status} on ${deps.side}`);
    }
    counts[kind] += 1;
    return response;
  };

  const read = async (service: "status" | "notify"): Promise<void> => {
    const isStatus = service === "status";
    const etag = etags[service];
    const response = await call(
      isStatus ? "statusRead" : "channelRead",
      isStatus ? "/service/status/settings" : "/service/notify/channels",
      {
        headers: bearer(deps.tokens[service], etag === null ? {} : { "if-none-match": etag }),
      },
    );
    const text = await response.text();
    if (response.status === 304) return;
    const body = parseOrFail(text, `${service} read`);
    const checked = isStatus
      ? validateServiceStatusSettings(body)
      : validateServiceNotifyChannels(body);
    if (!checked.ok) throw new HarnessError(`service traffic: invalid ${service} read`);
    etags[service] = response.headers.get("etag");
    revisions[service] = checked.value.revision;
  };

  const claim = async (): Promise<void> => {
    const response = await call("claim", "/service/notify/resends/claim", {
      method: "POST",
      headers: bearer(deps.tokens.notify),
    });
    const checked = validateResendClaimResponse(parseOrFail(await response.text(), "claim"));
    if (!checked.ok) throw new HarnessError("service traffic: invalid claim answer");
  };

  const report = async (service: "status" | "notify"): Promise<void> => {
    const at = deps.now();
    const common = { at, startedAt: at, appliedRevision: revisions[service] };
    const body =
      service === "status"
        ? { ...common, rejected: null, locked: [] }
        : {
            ...common,
            fileChannels: [],
            fileChannelsTotal: 0,
            shadowedIds: [],
            rejected: [],
            failed: [],
            failedTotal: 0,
          };
    const response = await call(
      service === "status" ? "statusReport" : "notifyReport",
      `/service/${service}/report`,
      {
        method: "PUT",
        headers: bearer(deps.tokens[service], { "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    await response.arrayBuffer();
  };

  const send = (kind: TrafficKind): Promise<void> => {
    switch (kind) {
      case "statusRead":
        return read("status");
      case "channelRead":
        return read("notify");
      case "claim":
        return claim();
      case "statusReport":
        return report("status");
      case "notifyReport":
        return report("notify");
      default: {
        const never: never = kind;
        throw new Error(`unknown traffic ${String(never)}`);
      }
    }
  };

  const timed = (async (): Promise<void> => {
    for (const item of trafficSchedule()) {
      // A late timer only delays the request: it is still sent, so the count holds.
      const left = start + item.at - deps.now();
      if (left > 0) await deps.wait(left);
      await send(item.kind);
    }
  })();
  // Keeps an early failure from being reported as unhandled before `finish` awaits it.
  timed.catch(() => undefined);

  return {
    finish: async () => {
      await timed;
      await send("statusReport");
      await send("notifyReport");
      checkTrafficCounts(deps.side, counts);
      return { ...counts };
    },
  };
}
