import type { Database } from "bun:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_MAX_BODY_BYTES,
  type NotifyServiceReport,
  RESEND_CLAIM_MAX,
  RESEND_CLAIM_TIMEOUT_MS,
  RESEND_COMMAND_MAX,
  RESEND_REQUEST_MAX,
  type ResendClaimResponse,
  type ResendCommand,
  type ResendCommandState,
  type ResendRequest,
  validateResendRequest,
  validateResendResultInput,
} from "@lorenzh/pulse-contract";
import { sendJson } from "@lorenzh/pulse-kit";
import type { AdminAuthThrottle } from "./admin-auth-throttle.ts";
import type { AuditLog } from "./audit-log.ts";
import { AUDIT_WRITE_FAILED } from "./config-write.ts";
import {
  assertMethod,
  authorizeRuntime,
  RuntimeRouteError,
  readJson,
  readText,
  sendRuntimeError,
} from "./runtime-http.ts";
import {
  type ResendStore,
  type RuntimeStore,
  reportState,
  runtimeRevision,
} from "./runtime-store.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken } from "./token-store.ts";
import type { WriteLock } from "./write-lock.ts";

/** The resend routes: the console's create and read, notify's claim and result. */
export type ResendPath = "admin-resends" | "admin-resend" | "service-claim" | "service-result";

/** A matched resend route; `id` is the raw command id segment, or "". */
export interface ResendMatch {
  path: ResendPath;
  id: string;
}

const ROUTE: Record<ResendPath, string> = {
  "admin-resends": "/admin/notify/resends",
  "admin-resend": "/admin/notify/resends/:id",
  "service-claim": "/service/notify/resends/claim",
  "service-result": "/service/notify/resends/:id/result",
};

const ALLOW: Record<ResendPath, string> = {
  "admin-resends": "POST",
  "admin-resend": "GET",
  "service-claim": "POST",
  "service-result": "POST",
};

const PERMISSION: Record<ResendPath, Permission> = {
  "admin-resends": "runtime-admin",
  "admin-resend": "runtime-admin",
  "service-claim": "notify-service",
  "service-result": "notify-service",
};

const ADMIN_RESEND = /^\/admin\/notify\/resends\/([^/]+)$/;
const SERVICE_RESULT = /^\/service\/notify\/resends\/([^/]+)\/result$/;

/** The resend route of `path`, or null. */
export function resendPathOf(path: string): ResendMatch | null {
  if (path === "/admin/notify/resends") return { path: "admin-resends", id: "" };
  if (path === "/service/notify/resends/claim") return { path: "service-claim", id: "" };
  const admin = ADMIN_RESEND.exec(path)?.[1];
  if (admin !== undefined) return { path: "admin-resend", id: admin };
  const result = SERVICE_RESULT.exec(path)?.[1];
  return result === undefined ? null : { path: "service-result", id: result };
}

/** The metric label of a resend route: a literal pattern, never the raw path. */
export function resendRouteOf(path: ResendPath): string {
  return ROUTE[path];
}

/** True for a route under `/service/notify/resends`. */
export function isServiceResendPath(path: ResendPath): boolean {
  return path === "service-claim" || path === "service-result";
}

const FINAL: ReadonlySet<ResendCommandState> = new Set(["delivered", "failed", "dropped"]);

/** Decision 14: true when posting `posted` over `stored` is accepted (204). */
function isResultAccepted(stored: ResendCommandState, posted: ResendCommandState): boolean {
  if (posted === stored) return true;
  if (stored === "queued" || stored === "claimed") return true;
  if (stored === "admitted") return FINAL.has(posted);
  return FINAL.has(stored) && posted === "admitted";
}

/** Decision 14: true when the result changes the stored state. */
function isResultStored(stored: ResendCommandState, posted: ResendCommandState): boolean {
  return posted !== stored && !(FINAL.has(stored) && posted === "admitted");
}

export interface ResendRoutesDeps {
  db: Database;
  store: RuntimeStore;
  resends: ResendStore;
  lock: WriteLock;
  audit: Pick<AuditLog, "record">;
  throttle: AdminAuthThrottle;
  now: () => number;
  /** 24 random base64url characters. */
  newId: () => string;
  info: (message: string, fields: Record<string, string>) => void;
}

const RETRY = { "retry-after": "60" };

type CreateAnswer = { status: 200 | 202; command: ResendCommand };

/** Serve one resend route; the caller has matched it with `resendPathOf`. */
export function createResendRoutes(
  deps: ResendRoutesDeps,
): (req: IncomingMessage, res: ServerResponse, match: ResendMatch) => Promise<void> {
  const { resends } = deps;

  const failedReport = (): NotifyServiceReport => {
    const stored = deps.store.report("notify");
    if (stored === null || reportState(stored, deps.now()) !== "fresh") {
      throw new RuntimeRouteError(503, "pulse-notify has not reported recently");
    }
    // Only validated reports are stored.
    return JSON.parse(stored.json) as NotifyServiceReport;
  };

  const assertRequestRoom = (): void => {
    if (resends.requestCount() >= RESEND_REQUEST_MAX) {
      throw new RuntimeRouteError(503, "too many resend requests", RETRY);
    }
  };

  /** Step 1: a stored requestId answers 200 or 409, never a new row. */
  const repeatOf = (input: ResendRequest): CreateAnswer | null => {
    const known = resends.request(input.requestId);
    if (known === null) return null;
    if (known.channelId !== input.channelId || known.key !== input.key) {
      throw new RuntimeRouteError(409, "requestId was used for another delivery");
    }
    const command = resends.command(known.commandId);
    if (command === null) {
      throw new RuntimeRouteError(
        409,
        "the resend request was already handled; reload the failed list",
      );
    }
    return { status: 200, command };
  };

  const createNew = (input: ResendRequest, caller: AuthenticatedToken, at: number) => {
    const report = failedReport();
    if (!report.failed.some((f) => f.channelId === input.channelId && f.key === input.key)) {
      throw new RuntimeRouteError(409, "not a failed delivery");
    }
    assertRequestRoom();
    if (resends.commandCount() >= RESEND_COMMAND_MAX && !resends.deleteOldestFinished()) {
      throw new RuntimeRouteError(503, "too many open resend commands", RETRY);
    }
    const command: ResendCommand = {
      id: deps.newId(),
      channelId: input.channelId,
      key: input.key,
      requestId: input.requestId,
      state: "queued",
      createdAt: at,
      updatedAt: at,
    };
    resends.insertCommand(command);
    resends.insertRequest({ ...input, commandId: command.id, createdAt: at });
    try {
      deps.audit.record({
        at,
        actor: { tokenId: caller.id, name: caller.name },
        action: "notify-resend.create",
        target: { kind: "notify-resend", id: command.id },
        revision: runtimeRevision("notify", deps.store.generation("notify")),
      });
    } catch (err) {
      throw new Error(AUDIT_WRITE_FAILED, { cause: err });
    }
    return command;
  };

  const create = async (req: IncomingMessage, caller: AuthenticatedToken) => {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const v = validateResendRequest(body);
    if (!v.ok) throw new RuntimeRouteError(422, v.error);
    const input = v.value;
    return deps.lock.run(() =>
      // A thrown answer rolls back every row of this transaction.
      deps.db.transaction((): CreateAnswer => {
        const repeat = repeatOf(input);
        if (repeat !== null) return repeat;
        const at = deps.now();
        const open = resends.openCommandFor(input.channelId, input.key);
        if (open !== null) {
          assertRequestRoom();
          resends.insertRequest({ ...input, commandId: open.id, createdAt: at });
          return { status: 200, command: open };
        }
        return { status: 202, command: createNew(input, caller, at) };
      })(),
    );
  };

  const claim = async (req: IncomingMessage): Promise<ResendClaimResponse> => {
    // Read only to hold the size limit.
    await readText(req, ADMIN_MAX_BODY_BYTES);
    return deps.lock.run(() =>
      deps.db.transaction(() => ({
        commands: resends.claim(deps.now(), RESEND_CLAIM_TIMEOUT_MS, RESEND_CLAIM_MAX),
      }))(),
    );
  };

  const result = async (req: IncomingMessage, id: string): Promise<ResendCommandState> => {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const v = validateResendResultInput(body);
    if (!v.ok) throw new RuntimeRouteError(422, v.error);
    const posted = v.value.state;
    await deps.lock.run(() =>
      deps.db.transaction(() => {
        const command = resends.command(id);
        if (command === null) throw new RuntimeRouteError(404, "not found");
        if (!isResultAccepted(command.state, posted)) {
          throw new RuntimeRouteError(409, `result ${posted} does not follow ${command.state}`);
        }
        if (isResultStored(command.state, posted)) resends.setState(id, posted, deps.now());
      })(),
    );
    return posted;
  };

  const dispatch = async (req: IncomingMessage, res: ServerResponse, { path, id }: ResendMatch) => {
    const caller = authorizeRuntime(deps.throttle, req, ROUTE[path], PERMISSION[path]);
    assertMethod(req.method ?? "GET", ALLOW[path]);
    switch (path) {
      case "admin-resends": {
        const answer = await create(req, caller);
        deps.info("notify resend", { token: caller.name, status: String(answer.status) });
        sendJson(res, answer.status, answer.command);
        return;
      }
      case "admin-resend": {
        await readText(req, ADMIN_MAX_BODY_BYTES);
        const command = resends.command(id);
        if (command === null) throw new RuntimeRouteError(404, "not found");
        sendJson(res, 200, command);
        return;
      }
      case "service-claim": {
        const answer = await claim(req);
        deps.info("service resend claim", { route: ROUTE[path], service: "notify" });
        sendJson(res, 200, answer);
        return;
      }
      case "service-result": {
        const state = await result(req, id);
        deps.info("service resend result", {
          route: ROUTE[path],
          service: "notify",
          command: id,
          state,
        });
        res.writeHead(204).end();
        return;
      }
      default: {
        const never: never = path;
        throw new Error(`unknown resend path ${String(never)}`);
      }
    }
  };

  return async (req, res, match) => {
    res.setHeader("cache-control", "no-store");
    try {
      await dispatch(req, res, match);
    } catch (err) {
      sendRuntimeError(res, err);
    }
  };
}
