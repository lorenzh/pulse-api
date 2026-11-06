import type { Database } from "bun:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ADMIN_ETAG_HEADER,
  ADMIN_MAX_BODY_BYTES,
  type AdminStatusSettingsView,
  SERVICE_REPORT_MAX_BYTES,
  type StatusServiceReport,
  type StatusServiceState,
  type StatusSettings,
  validateStatusServiceReport,
  validateStatusSettings,
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
  type ReportingService,
  type RuntimeStore,
  reportState,
  runtimeRevision,
} from "./runtime-store.ts";
import type { Permission } from "./token-scopes.ts";
import type { AuthenticatedToken } from "./token-store.ts";
import type { WriteLock } from "./write-lock.ts";

/** The status routes: the console's settings and the status service's read and report. */
export type StatusPath = "admin-settings" | "service-settings" | "service-report";

const PATHS: Record<string, StatusPath> = {
  "/admin/status/settings": "admin-settings",
  "/service/status/settings": "service-settings",
  "/service/status/report": "service-report",
};

const ROUTE: Record<StatusPath, string> = {
  "admin-settings": "/admin/status/settings",
  "service-settings": "/service/status/settings",
  "service-report": "/service/status/report",
};

const ALLOW: Record<StatusPath, string> = {
  "admin-settings": "GET, PUT",
  "service-settings": "GET",
  "service-report": "PUT",
};

const PERMISSION: Record<StatusPath, Permission> = {
  "admin-settings": "runtime-admin",
  "service-settings": "status-service",
  "service-report": "status-service",
};

/** The status route of `path`, or null. */
export function statusPathOf(path: string): StatusPath | null {
  return Object.hasOwn(PATHS, path) ? (PATHS[path] ?? null) : null;
}

/** The metric label of a status route: a literal pattern, never the raw path. */
export function statusRouteOf(path: StatusPath): string {
  return ROUTE[path];
}

export interface StatusRoutesDeps {
  db: Database;
  store: RuntimeStore;
  lock: WriteLock;
  audit: Pick<AuditLog, "record">;
  /** The ids of the components in use (the applied file and the database). */
  componentIds: () => ReadonlySet<string>;
  /** One throttle with `/admin/*`, so every route draws from one budget per client. */
  throttle: AdminAuthThrottle;
  now: () => number;
  info: (message: string, fields: Record<string, string>) => void;
}

function assertComponents(settings: StatusSettings, ids: ReadonlySet<string>): void {
  (settings.componentOrder ?? []).forEach((id, i) => {
    if (!ids.has(id)) {
      throw new RuntimeRouteError(
        422,
        `settings.componentOrder[${i}]: must reference a current component`,
      );
    }
  });
}

/** Serve one status route; the caller has matched `path` with `statusPathOf`. */
export function createStatusRoutes(
  deps: StatusRoutesDeps,
): (req: IncomingMessage, res: ServerResponse, path: StatusPath) => Promise<void> {
  const { store } = deps;
  const revision = (): string => runtimeRevision("status", store.generation("status"));

  const authorize = (req: IncomingMessage, path: StatusPath): AuthenticatedToken =>
    authorizeRuntime(deps.throttle, req, ROUTE[path], PERMISSION[path]);

  const serviceState = (service: ReportingService): StatusServiceState => {
    const stored = store.report(service);
    const state = reportState(stored, deps.now());
    if (stored === null || state === "never") {
      return { state: "never", receivedAt: null, report: null };
    }
    // Only validated reports are stored.
    const report = JSON.parse(stored.json) as StatusServiceReport;
    return { state, receivedAt: stored.receivedAt, report };
  };

  const adminView = (): AdminStatusSettingsView => ({
    revision: revision(),
    settings: store.statusSettings(),
    service: serviceState("status"),
  });

  const sendView = (res: ServerResponse, status: number): void => {
    const view = adminView();
    // The service part changes without a revision change, so the view is never cached.
    sendJson(res, status, view, {
      "cache-control": "no-store",
      [ADMIN_ETAG_HEADER]: etagOf(view.revision),
    });
  };

  /** Settings, generation and audit entry commit together or not at all. */
  const commit = (settings: StatusSettings, actor: WriteActor): void => {
    try {
      deps.db.transaction(() => {
        store.replaceStatusSettings(settings);
        const generation = store.bumpGeneration("status");
        deps.audit.record({
          at: deps.now(),
          actor,
          action: "status-settings.replace",
          target: { kind: "status-settings", id: "status" },
          revision: runtimeRevision("status", generation),
        });
      })();
    } catch (err) {
      throw new Error(AUDIT_WRITE_FAILED, { cause: err });
    }
  };

  const replace = async (req: IncomingMessage, caller: AuthenticatedToken): Promise<void> => {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const ifMatch = ifMatchOf(req.headers["if-match"]);
    await deps.lock.run(() => {
      if (revision() !== ifMatch) throw new RuntimeRouteError(412, STALE_SETTINGS);
      const v = validateStatusSettings(body);
      if (!v.ok) throw new RuntimeRouteError(422, v.error);
      assertComponents(v.value, deps.componentIds());
      commit(v.value, { tokenId: caller.id, name: caller.name });
    });
    deps.info("status settings write", { token: caller.name });
  };

  const report = async (req: IncomingMessage): Promise<void> => {
    const body = await readJson(req, SERVICE_REPORT_MAX_BYTES);
    const v = validateStatusServiceReport(body);
    if (!v.ok) throw new RuntimeRouteError(422, v.error);
    const json = JSON.stringify(v.value);
    // A report bumps no generation and writes no audit row.
    await deps.lock.run(() =>
      deps.db.transaction(() => store.replaceReport("status", { json, receivedAt: deps.now() }))(),
    );
  };

  const serveSettings = (req: IncomingMessage, res: ServerResponse): void => {
    const current = revision();
    const tag = etagOf(current);
    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, { [ADMIN_ETAG_HEADER]: tag }).end();
      return;
    }
    sendJson(
      res,
      200,
      { revision: current, settings: store.statusSettings() },
      {
        [ADMIN_ETAG_HEADER]: tag,
      },
    );
  };

  const dispatch = async (
    req: IncomingMessage,
    res: ServerResponse,
    path: StatusPath,
  ): Promise<void> => {
    const caller = authorize(req, path);
    const method = req.method ?? "GET";
    assertMethod(method, ALLOW[path]);
    if (method === "GET") {
      // Read only to hold the size limit on every method.
      await readText(req, ADMIN_MAX_BODY_BYTES);
      if (path === "admin-settings") sendView(res, 200);
      else serveSettings(req, res);
      return;
    }
    if (path === "admin-settings") {
      await replace(req, caller);
      sendView(res, 200);
      return;
    }
    await report(req);
    deps.info("service report", { route: ROUTE[path], service: "status" });
    res.writeHead(204).end();
  };

  return async (req, res, path) => {
    if (path === "admin-settings") res.setHeader("cache-control", "no-store");
    try {
      await dispatch(req, res, path);
    } catch (err) {
      sendRuntimeError(res, err);
    }
  };
}
