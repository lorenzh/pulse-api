import type { IncomingMessage, ServerResponse } from "node:http";
import { MANUAL_INCIDENT_MAX_BODY_BYTES } from "@lorenzh/pulse-contract";
import { BodyError, readBody, readJsonBody, sendJson } from "@lorenzh/pulse-kit";
import {
  ManualIncidentConflictError,
  type ManualIncidentFilter,
  ManualIncidentInputError,
  ManualIncidentNoteNotFoundError,
  ManualIncidentNotFoundError,
  type ManualIncidentStore,
} from "./manual-incidents.ts";
import type { Actor } from "./token-store.ts";

const PREFIX = "/admin/manual-incidents";
const PRIVATE_PATH =
  /^\/admin\/manual-incidents(?:\/([^/]+)(?:\/(draft|publish|notes)(?:\/([^/]+))?)?)?$/;
const ID = /^\d{1,15}$/;

/** A refusal of a private route, answered with `status` and an `ErrorResponse`. */
export class ManualRouteError extends Error {
  override name = "ManualRouteError";
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

type Shape = "list" | "item" | "draft" | "publish" | "notes" | "note";

type Action =
  | "list"
  | "get"
  | "create-draft"
  | "edit"
  | "delete"
  | "save-draft"
  | "discard-draft"
  | "publish"
  | "add-note"
  | "delete-note";

const ACTIONS: Record<string, Action> = {
  "GET list": "list",
  "POST list": "create-draft",
  "GET item": "get",
  "PUT item": "edit",
  "DELETE item": "delete",
  "PUT draft": "save-draft",
  "DELETE draft": "discard-draft",
  "POST publish": "publish",
  "POST notes": "add-note",
  "DELETE note": "delete-note",
};

const ALLOW: Record<Shape, string> = {
  list: "GET, POST",
  item: "GET, PUT, DELETE",
  draft: "PUT, DELETE",
  publish: "POST",
  notes: "POST",
  note: "DELETE",
};

const ROUTES: Record<Shape, string> = {
  list: PREFIX,
  item: `${PREFIX}/:id`,
  draft: `${PREFIX}/:id/draft`,
  publish: `${PREFIX}/:id/publish`,
  notes: `${PREFIX}/:id/notes`,
  note: `${PREFIX}/:id/notes/:noteId`,
};

const SUB_SHAPES: Record<string, Shape> = {
  item: "item",
  draft: "draft",
  publish: "publish",
  notes: "notes",
};

type Target = { shape: Shape; id: number | undefined; noteId: number | undefined };

/** True for `/admin/manual-incidents` and every path below it, matched or not. */
export function isPrivateManualPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

/** True when the request target parses to a private path; such requests are never counted. */
export function isPrivateManualTarget(rawUrl: string | undefined): boolean {
  try {
    return isPrivateManualPath(new URL(rawUrl ?? "/", "http://localhost").pathname);
  } catch {
    // An unparsable target is not a private path; the request hook counts it as unmatched.
    return false;
  }
}

function idOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!ID.test(text)) throw new ManualRouteError(404, "not found");
  return Number(text);
}

/** The route shape and ids of a private path; an unknown shape or a bad id is 404. */
function targetOf(path: string): Target {
  const match = PRIVATE_PATH.exec(path);
  if (match === null) throw new ManualRouteError(404, "not found");
  const id = idOf(match[1]);
  const sub = match[2];
  const noteId = idOf(match[3]);
  if (noteId !== undefined && sub !== "notes") throw new ManualRouteError(404, "not found");
  if (noteId !== undefined) return { shape: "note", id, noteId };
  if (id === undefined) return { shape: "list", id, noteId };
  return { shape: SUB_SHAPES[sub ?? "item"] ?? "item", id, noteId };
}

function bodyFailure(err: unknown): unknown {
  if (!(err instanceof BodyError)) return err;
  if (err.code === "too-large") return new ManualRouteError(413, "request body too large");
  if (err.code === "invalid-json") return new ManualRouteError(400, "body is not valid JSON");
  return new ManualRouteError(400, "request body could not be read");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(req, { maxBytes: MANUAL_INCIDENT_MAX_BODY_BYTES });
  } catch (err) {
    throw bodyFailure(err);
  }
}

/** Reads and drops a body that the route ignores, so the size limit still holds. */
async function skipBody(req: IncomingMessage): Promise<void> {
  try {
    await readBody(req, MANUAL_INCIDENT_MAX_BODY_BYTES);
  } catch (err) {
    throw bodyFailure(err);
  }
}

function filterOf(url: URL): ManualIncidentFilter {
  const status = url.searchParams.get("status");
  if (status === null || status === "all") return "all";
  if (status === "open" || status === "resolved") return status;
  throw new ManualRouteError(400, 'status must be "open", "resolved" or "all"');
}

function storeFailure(err: unknown): unknown {
  if (err instanceof ManualIncidentInputError) return new ManualRouteError(400, err.message);
  if (err instanceof ManualIncidentNotFoundError) {
    return new ManualRouteError(404, "manual incident not found");
  }
  if (err instanceof ManualIncidentNoteNotFoundError) {
    return new ManualRouteError(404, "note not found");
  }
  if (err instanceof ManualIncidentConflictError) return new ManualRouteError(409, err.message);
  return err;
}

function needId(id: number | undefined): number {
  // The action table gives item actions only on paths that carry an id.
  if (id === undefined) throw new ManualRouteError(404, "not found");
  return id;
}

type LogFn = (message: string, fields: Record<string, string>) => void;

export interface ManualRouteDeps {
  store: ManualIncidentStore;
  /** Bootstrap check and admin auth with the shared throttle; throws the refusal. */
  authorize: (req: IncomingMessage, route: string) => Actor;
  info: LogFn;
  warn: LogFn;
}

/** Runs one write and answers it; returns the id of the incident written. */
async function applyWrite(
  deps: ManualRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  action: Exclude<Action, "list" | "get">,
  target: Target,
  actor: Actor,
): Promise<number> {
  const { store } = deps;
  if (action === "create-draft") {
    const created = store.createDraft(await readJson(req), actor);
    sendJson(res, 201, created);
    return created.id;
  }
  const id = needId(target.id);
  switch (action) {
    case "edit":
      sendJson(res, 200, store.editDraft(id, await readJson(req), actor));
      return id;
    case "save-draft":
      sendJson(res, 200, store.saveDraftUpdate(id, await readJson(req), actor));
      return id;
    case "add-note":
      sendJson(res, 201, store.addNote(id, await readJson(req), actor));
      return id;
    case "publish":
      await skipBody(req);
      sendJson(res, 200, store.publish(id, actor));
      return id;
    case "delete":
      await skipBody(req);
      store.removeAny(id, actor);
      break;
    case "discard-draft":
      await skipBody(req);
      store.discardDraftUpdate(id, actor);
      break;
    case "delete-note":
      await skipBody(req);
      store.deleteNote(id, needId(target.noteId), actor);
      break;
    default: {
      const never: never = action;
      return never;
    }
  }
  res.writeHead(204).end();
  return id;
}

/**
 * Serves `/admin/manual-incidents[/<id>[/draft|/publish|/notes[/<noteId>]]]`. Order: path and
 * id (404), method (405), bootstrap and auth (404, 401, 403, 429), body (413, 400), existence
 * (404), state (409).
 */
export async function serveManualIncidentRoutes(
  deps: ManualRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const target = targetOf(url.pathname);
  const action = ACTIONS[`${req.method ?? "GET"} ${target.shape}`];
  if (action === undefined) {
    throw new ManualRouteError(405, "method not allowed", { Allow: ALLOW[target.shape] });
  }
  const actor = deps.authorize(req, ROUTES[target.shape]);
  try {
    if (action === "list") {
      sendJson(res, 200, deps.store.listInternal(filterOf(url)));
      return;
    }
    if (action === "get") {
      const incident = deps.store.getInternal(needId(target.id));
      if (incident === undefined) throw new ManualRouteError(404, "manual incident not found");
      sendJson(res, 200, incident);
      return;
    }
    const written = await applyWrite(deps, req, res, action, target, actor);
    // Names, the action and the id only: no title, message, note, body or header value.
    deps.info("manual incident write", { token: actor.name, action, id: String(written) });
  } catch (err) {
    const failure = storeFailure(err);
    // Private reads are not logged; a 500 is logged once, as "request failed".
    if (failure instanceof ManualRouteError && action !== "list" && action !== "get") {
      const fields: Record<string, string> = { status: String(failure.status), action };
      if (target.id !== undefined) fields.id = String(target.id);
      deps.warn("manual incident write failed", fields);
    }
    throw failure;
  }
}
