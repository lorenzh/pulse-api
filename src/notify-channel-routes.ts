import type { Database } from "bun:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_ETAG_HEADER,
  ADMIN_MAX_BODY_BYTES,
  type AdminNotifyChannelsView,
  type AdminNotifyFailedView,
  type AuditAction,
  NOTIFY_CHANNEL_MAX,
  NOTIFY_CHANNELS_MAX_BYTES,
  type NotifyChannelDefinition,
  type NotifyChannelRecord,
  type NotifyServiceReport,
  type NotifyServiceState,
  SERVICE_REPORT_MAX_BYTES,
  type ServiceNotifyChannels,
  validateNotifyChannelDefinition,
  validateNotifyServiceReport,
} from "@lorenzh/pulse-contract";
import { sendJson } from "@lorenzh/pulse-kit";
import type { AdminAuthThrottle } from "./admin-auth-throttle.ts";
import type { AuditLog } from "./audit-log.ts";
import { AUDIT_WRITE_FAILED, type WriteActor } from "./config-write.ts";
import {
  assertMethod,
  authorizeRuntime,
  etagOf,
  ifMatchOf,
  RuntimeRouteError,
  readJson,
  readText,
  STALE_SETTINGS,
  sendRuntimeError,
} from "./runtime-http.ts";
import {
  type RuntimeStore,
  reportState,
  runtimeRevision,
  type StoredChannel,
} from "./runtime-store.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken } from "./token-store.ts";
import type { WriteLock } from "./write-lock.ts";

/** The notify routes: the console's channels and failed view, notify's read and report. */
export type NotifyPath =
  | "admin-channels"
  | "admin-channel"
  | "admin-failed"
  | "service-channels"
  | "service-report";

/** A matched notify route; `id` is the raw path segment of `admin-channel`. */
export interface NotifyMatch {
  path: NotifyPath;
  id: string;
}

const PATHS: Record<string, NotifyPath> = {
  "/admin/notify/channels": "admin-channels",
  "/admin/notify/failed": "admin-failed",
  "/service/notify/channels": "service-channels",
  "/service/notify/report": "service-report",
};

const CHANNEL_PATH = /^\/admin\/notify\/channels\/([^/]+)$/;

const ROUTE: Record<NotifyPath, string> = {
  "admin-channels": "/admin/notify/channels",
  "admin-channel": "/admin/notify/channels/:id",
  "admin-failed": "/admin/notify/failed",
  "service-channels": "/service/notify/channels",
  "service-report": "/service/notify/report",
};

const ALLOW: Record<NotifyPath, string> = {
  "admin-channels": "GET, POST",
  "admin-channel": "PUT, DELETE",
  "admin-failed": "GET",
  "service-channels": "GET",
  "service-report": "PUT",
};

const PERMISSION: Record<NotifyPath, Permission> = {
  "admin-channels": "runtime-admin",
  "admin-channel": "runtime-admin",
  "admin-failed": "runtime-admin",
  "service-channels": "notify-service",
  "service-report": "notify-service",
};

/** The notify route of `path`, or null. */
export function notifyPathOf(path: string): NotifyMatch | null {
  if (Object.hasOwn(PATHS, path)) {
    const named = PATHS[path];
    return named === undefined ? null : { path: named, id: "" };
  }
  const id = CHANNEL_PATH.exec(path)?.[1];
  return id === undefined ? null : { path: "admin-channel", id };
}

/** The metric label of a notify route: a literal pattern, never the raw path. */
export function notifyRouteOf(path: NotifyPath): string {
  return ROUTE[path];
}

/** True for a route under `/service/notify/`. */
export function isServiceNotifyPath(path: NotifyPath): boolean {
  return path === "service-channels" || path === "service-report";
}

export interface NotifyRoutesDeps {
  db: Database;
  store: RuntimeStore;
  lock: WriteLock;
  audit: Pick<AuditLog, "record">;
  /** One throttle with `/admin/*`, so every route draws from one budget per client. */
  throttle: AdminAuthThrottle;
  now: () => number;
  info: (message: string, fields: Record<string, string>) => void;
}

function recordOf(c: StoredChannel): NotifyChannelRecord {
  // Only validated definitions are stored.
  const definition = JSON.parse(c.definitionJson) as NotifyChannelDefinition;
  return { ...definition, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

function bytesOf(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

/** The validated definition and its JSON: 422 on any contract rule. */
function definitionOf(body: unknown): { definition: NotifyChannelDefinition; json: string } {
  const v = validateNotifyChannelDefinition(body);
  if (!v.ok) throw new RuntimeRouteError(422, v.error);
  return { definition: v.value, json: JSON.stringify(v.value) };
}

/** 422 when the channels with `json` in place of `replacing` exceed 262 144 bytes. */
function assertAggregate(channels: StoredChannel[], json: string, replacing: string | null): void {
  const others = channels
    .filter((c) => c.id !== replacing)
    .reduce((sum, c) => sum + bytesOf(c.definitionJson), 0);
  if (others + bytesOf(json) > NOTIFY_CHANNELS_MAX_BYTES) {
    throw new RuntimeRouteError(
      422,
      `channels: must be at most ${NOTIFY_CHANNELS_MAX_BYTES} bytes as JSON in total`,
    );
  }
}

/** 400 when the body is an object whose own `id` differs from the path id. */
function assertBodyId(body: unknown, id: string): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const descriptor = Object.getOwnPropertyDescriptor(body, "id");
  if (descriptor !== undefined && "value" in descriptor && descriptor.value !== id) {
    throw new RuntimeRouteError(400, "channel id must equal the path id");
  }
}

/** Serve one notify route; the caller has matched it with `notifyPathOf`. */
export function createNotifyRoutes(
  deps: NotifyRoutesDeps,
): (req: IncomingMessage, res: ServerResponse, match: NotifyMatch) => Promise<void> {
  const { store } = deps;
  const revision = (): string => runtimeRevision("notify", store.generation("notify"));

  const lastReport = (): { report: NotifyServiceReport | null; state: NotifyServiceState } => {
    const stored = store.report("notify");
    const state = reportState(stored, deps.now());
    if (stored === null || state === "never") {
      return { report: null, state: { state: "never", receivedAt: null, report: null } };
    }
    // Only validated reports are stored.
    const report = JSON.parse(stored.json) as NotifyServiceReport;
    return { report, state: { state, receivedAt: stored.receivedAt, report } };
  };

  /** Shadowed ids come from the last report, also a stale one. */
  const shadowedIds = (): ReadonlySet<string> => new Set(lastReport().report?.shadowedIds ?? []);

  const adminView = (): AdminNotifyChannelsView => {
    const { report, state } = lastReport();
    const shadowedSet = new Set(report?.shadowedIds ?? []);
    const view: AdminNotifyChannelsView = {
      revision: revision(),
      channels: [],
      shadowed: [],
      service: state,
    };
    for (const c of store.notifyChannels()) {
      const entry = { ...recordOf(c), source: "database" as const };
      (shadowedSet.has(c.id) ? view.shadowed : view.channels).push(entry);
    }
    return view;
  };

  const sendView = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
    const view = adminView();
    // The service part changes without a revision change, so the view is never cached.
    sendJson(res, status, view, {
      "cache-control": "no-store",
      [ADMIN_ETAG_HEADER]: etagOf(view.revision),
      ...headers,
    });
  };

  const failedView = (): AdminNotifyFailedView => {
    const { report, state } = lastReport();
    if (report === null) return { state: "never", receivedAt: null, failed: [], failedTotal: 0 };
    return {
      state: state.state,
      receivedAt: state.receivedAt,
      failed: report.failed,
      failedTotal: report.failedTotal,
    };
  };

  /** Run `write` with the generation bump and the audit row in one transaction. */
  const commit = (action: AuditAction, id: string, actor: WriteActor, write: () => void) => {
    try {
      deps.db.transaction(() => {
        write();
        const generation = store.bumpGeneration("notify");
        deps.audit.record({
          at: deps.now(),
          actor,
          action,
          target: { kind: "notify-channel", id },
          revision: runtimeRevision("notify", generation),
        });
      })();
    } catch (err) {
      throw new Error(AUDIT_WRITE_FAILED, { cause: err });
    }
  };

  /** Read the body, then If-Match, then take the lock and check the revision. */
  const guarded = async (
    req: IncomingMessage,
    run: (body: unknown) => void,
    hasBody = true,
  ): Promise<void> => {
    const body = hasBody
      ? await readJson(req, ADMIN_MAX_BODY_BYTES)
      : await readText(req, ADMIN_MAX_BODY_BYTES);
    const ifMatch = ifMatchOf(req.headers["if-match"]);
    await deps.lock.run(() => {
      if (revision() !== ifMatch) throw new RuntimeRouteError(412, STALE_SETTINGS);
      run(body);
    });
  };

  const actorOf = (caller: AuthenticatedToken): WriteActor => ({
    tokenId: caller.id,
    name: caller.name,
  });

  const create = async (req: IncomingMessage, caller: AuthenticatedToken): Promise<string> => {
    let created = "";
    await guarded(req, (body) => {
      const { definition, json } = definitionOf(body);
      const channels = store.notifyChannels();
      if (channels.length >= NOTIFY_CHANNEL_MAX) {
        throw new RuntimeRouteError(
          422,
          `channels: must hold at most ${NOTIFY_CHANNEL_MAX} channels`,
        );
      }
      assertAggregate(channels, json, null);
      const fileIds = new Set((lastReport().report?.fileChannels ?? []).map((f) => f.id));
      if (channels.some((c) => c.id === definition.id) || fileIds.has(definition.id)) {
        throw new RuntimeRouteError(409, "a channel with this id exists");
      }
      const at = deps.now();
      commit("notify-channel.create", definition.id, actorOf(caller), () =>
        store.insertNotifyChannel({
          id: definition.id,
          definitionJson: json,
          createdAt: at,
          updatedAt: at,
        }),
      );
      created = definition.id;
    });
    return created;
  };

  const replace = async (req: IncomingMessage, caller: AuthenticatedToken, id: string) => {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    assertBodyId(body, id);
    const ifMatch = ifMatchOf(req.headers["if-match"]);
    await deps.lock.run(() => {
      if (revision() !== ifMatch) throw new RuntimeRouteError(412, STALE_SETTINGS);
      const { json } = definitionOf(body);
      const channels = store.notifyChannels();
      assertAggregate(channels, json, id);
      if (!channels.some((c) => c.id === id)) throw new RuntimeRouteError(404, "not found");
      if (shadowedIds().has(id)) {
        throw new RuntimeRouteError(409, "the channel is shadowed by the channel file: delete it");
      }
      commit("notify-channel.replace", id, actorOf(caller), () =>
        store.replaceNotifyChannel(id, json, deps.now()),
      );
    });
  };

  const remove = (req: IncomingMessage, caller: AuthenticatedToken, id: string) =>
    guarded(
      req,
      () => {
        if (!store.notifyChannels().some((c) => c.id === id)) {
          throw new RuntimeRouteError(404, "not found");
        }
        commit("notify-channel.delete", id, actorOf(caller), () => {
          store.deleteNotifyChannel(id);
        });
      },
      false,
    );

  const report = async (req: IncomingMessage): Promise<void> => {
    const body = await readJson(req, SERVICE_REPORT_MAX_BYTES);
    const v = validateNotifyServiceReport(body);
    if (!v.ok) throw new RuntimeRouteError(422, v.error);
    const json = JSON.stringify(v.value);
    // A report bumps no generation and writes no audit row.
    await deps.lock.run(() =>
      deps.db.transaction(() => store.replaceReport("notify", { json, receivedAt: deps.now() }))(),
    );
  };

  const serveChannels = (req: IncomingMessage, res: ServerResponse): void => {
    const current = revision();
    const tag = etagOf(current);
    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, { [ADMIN_ETAG_HEADER]: tag }).end();
      return;
    }
    const answer: ServiceNotifyChannels = {
      revision: current,
      channels: store.notifyChannels().map(recordOf),
    };
    sendJson(res, 200, answer, { [ADMIN_ETAG_HEADER]: tag });
  };

  const serveGet = async (req: IncomingMessage, res: ServerResponse, path: NotifyPath) => {
    // Read only to hold the size limit on every method.
    await readText(req, ADMIN_MAX_BODY_BYTES);
    if (path === "admin-channels") sendView(res, 200);
    else if (path === "admin-failed")
      sendJson(res, 200, failedView(), { "cache-control": "no-store" });
    else serveChannels(req, res);
  };

  const dispatch = async (
    req: IncomingMessage,
    res: ServerResponse,
    { path, id }: NotifyMatch,
  ): Promise<void> => {
    const caller = authorize(req, path);
    const method = req.method ?? "GET";
    assertMethod(method, ALLOW[path]);
    if (method === "GET") return serveGet(req, res, path);
    if (path === "admin-channels") {
      const created = await create(req, caller);
      deps.info("notify channel write", { token: caller.name, action: "create" });
      return sendView(res, 201, { location: `/admin/notify/channels/${created}` });
    }
    if (path === "admin-channel" && method === "PUT") {
      await replace(req, caller, id);
      deps.info("notify channel write", { token: caller.name, action: "replace" });
      return sendView(res, 200);
    }
    if (path === "admin-channel") {
      await remove(req, caller, id);
      deps.info("notify channel write", { token: caller.name, action: "delete" });
      res.writeHead(204, { [ADMIN_ETAG_HEADER]: etagOf(revision()) }).end();
      return;
    }
    await report(req);
    deps.info("service report", { route: ROUTE[path], service: "notify" });
    res.writeHead(204).end();
  };

  const authorize = (req: IncomingMessage, path: NotifyPath): AuthenticatedToken =>
    authorizeRuntime(deps.throttle, req, ROUTE[path], PERMISSION[path]);

  return async (req, res, match) => {
    if (!isServiceNotifyPath(match.path)) res.setHeader("cache-control", "no-store");
    try {
      await dispatch(req, res, match);
    } catch (err) {
      sendRuntimeError(res, err);
    }
  };
}
