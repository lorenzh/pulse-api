import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type InternalManualIncident,
  validateInternalManualIncident,
  validateManualIncident,
} from "@lorenzh/pulse-contract";
import type { AuditRecord } from "./audit-log.ts";
import { openDb } from "./db.ts";
import {
  createManualIncidentStore,
  ManualIncidentConflictError,
  ManualIncidentInputError,
  ManualIncidentNotFoundError,
  type ManualIncidentStore,
} from "./manual-incidents.ts";
import type { Actor } from "./token-store.ts";

const ACTOR: Actor = { tokenId: "t1", name: "ops" };
const DAY = 86_400_000;

type Env = {
  db: Database;
  store: ManualIncidentStore;
  events: string[];
  audits: AuditRecord[];
  setClock: (t: number) => void;
  setAuditDown: (down: boolean) => void;
  components: Set<string>;
};

function setup(): Env {
  const db = openDb(":memory:");
  let clock = 100;
  let isAuditDown = false;
  const events: string[] = [];
  const audits: AuditRecord[] = [];
  const components = new Set(["web", "db"]);
  const store = createManualIncidentStore(db, {
    now: () => clock,
    componentIds: () => components,
    onEvent: (e) => events.push(e),
    recordAudit: (entry) => {
      if (isAuditDown) throw new Error("audit down");
      audits.push(entry);
    },
  });
  return {
    db,
    store,
    events,
    audits,
    components,
    setClock: (t) => {
      clock = t;
    },
    setAuditDown: (down) => {
      isAuditDown = down;
    },
  };
}

const draftBody = (over: Record<string, unknown> = {}) => ({
  title: "DB slow",
  impact: "minor",
  componentIds: ["web"],
  message: "Looking.",
  visibility: "public",
  ...over,
});
const legacyBody = { title: "Legacy", impact: "minor", componentIds: ["web"], message: "m" };

function valid(incident: InternalManualIncident): InternalManualIncident {
  const v = validateInternalManualIncident(incident);
  expect(v.ok ? "" : v.error).toBe("");
  return incident;
}

function internal(store: ManualIncidentStore, id: number): InternalManualIncident {
  const found = store.getInternal(id);
  if (found === undefined) throw new Error(`no incident ${id}`);
  return valid(found);
}

test("a draft incident is private, holds one draft, and publishes at the publication time", () => {
  const { store, events, setClock } = setup();
  setClock(100);
  const draft = valid(store.createDraft(draftBody({ status: "identified" }), ACTOR));
  expect(draft).toMatchObject({
    createdAt: 100,
    publishedAt: null,
    status: "identified",
    visibility: "public",
    updates: [],
    draft: { status: "identified", message: "Looking.", savedAt: 100 },
    notes: [],
  });
  expect(store.list("all")).toEqual([]);
  expect(store.get(draft.id)).toBeUndefined();
  expect(store.listInternal("all").map((i) => i.id)).toEqual([draft.id]);

  setClock(200);
  const edited = valid(store.editDraft(draft.id, draftBody({ title: "New", message: "M2" })));
  expect(edited).toMatchObject({
    title: "New",
    status: "investigating",
    createdAt: 100,
    draft: { status: "investigating", message: "M2", savedAt: 200 },
  });
  expect(events).toEqual([]);

  setClock(300);
  const published = valid(store.publish(draft.id, ACTOR));
  expect(published).toMatchObject({
    createdAt: 100,
    publishedAt: 300,
    draft: null,
    updates: [{ at: 300, status: "investigating", message: "M2" }],
  });
  expect(events).toEqual(["created"]);
  const pub = store.get(draft.id);
  expect(pub).toEqual({
    id: draft.id,
    title: "New",
    componentIds: ["web"],
    impact: "minor",
    status: "investigating",
    createdAt: 300,
    resolvedAt: null,
    updates: [{ at: 300, status: "investigating", message: "M2" }],
  });
  expect(validateManualIncident(pub).ok).toBe(true);

  expect(() => store.publish(draft.id, ACTOR)).toThrow("manual incident has no draft");
  expect(store.get(draft.id)?.updates).toHaveLength(1);
  expect(events).toEqual(["created"]);
  expect(() => store.editDraft(draft.id, draftBody())).toThrow("manual incident is published");
});

test("a draft update stays private until publish; a later clock step back keeps the order", () => {
  const { store, events, setClock } = setup();
  setClock(1000);
  const id = store.create(legacyBody).id;
  events.length = 0;
  setClock(1100);
  valid(store.saveDraftUpdate(id, { status: "resolved", message: "U" }, ACTOR));
  const saved = valid(store.saveDraftUpdate(id, { status: "resolved", message: "U2" }, ACTOR));
  expect(saved.draft).toEqual({ status: "resolved", message: "U2", savedAt: 1100 });
  const before = store.get(id);
  expect(before).toMatchObject({ status: "investigating", resolvedAt: null });
  expect(before?.updates).toHaveLength(1);
  expect(JSON.stringify(store.list("all"))).not.toContain("U2");

  setClock(900);
  const after = valid(store.publish(id, ACTOR));
  expect(after.updates.at(-1)).toEqual({ at: 1000, status: "resolved", message: "U2" });
  expect(after).toMatchObject({ status: "resolved", resolvedAt: 1000, draft: null });
  expect(store.get(id)?.updates.map((u) => u.at)).toEqual([1000, 1000]);
  expect(events).toEqual(["resolved"]);
});

test("draft update rules: draft, resolved, no draft, discard", () => {
  const { store } = setup();
  const draftId = store.createDraft(draftBody()).id;
  expect(() => store.saveDraftUpdate(draftId, { status: "monitoring", message: "x" })).toThrow(
    "manual incident is a draft",
  );
  expect(() => store.discardDraftUpdate(draftId)).toThrow("manual incident is a draft");
  const id = store.create(legacyBody).id;
  expect(() => store.discardDraftUpdate(id)).toThrow("manual incident has no draft");
  store.saveDraftUpdate(id, { status: "monitoring", message: "x" });
  store.discardDraftUpdate(id);
  expect(internal(store, id).draft).toBeNull();
  store.resolve(id, undefined);
  expect(() => store.saveDraftUpdate(id, { status: "monitoring", message: "x" })).toThrow(
    "manual incident is resolved",
  );
  expect(() => store.publish(id)).toThrow("manual incident has no draft");
  expect(() => store.publish(999)).toThrow(ManualIncidentNotFoundError);
  expect(() => store.saveDraftUpdate(id, { status: "bad", message: "x" })).toThrow(
    ManualIncidentInputError,
  );
});

test("a legacy update keeps the draft; a legacy resolve deletes it", () => {
  const { store } = setup();
  const id = store.create(legacyBody).id;
  store.saveDraftUpdate(id, { status: "monitoring", message: "D" });
  store.addUpdate(id, { status: "identified", message: "u" });
  expect(internal(store, id).draft?.message).toBe("D");
  store.addUpdate(id, { status: "resolved", message: "done" });
  expect(internal(store, id).draft).toBeNull();
  expect(() => store.publish(id)).toThrow("manual incident has no draft");
});

test("legacy writes and reads treat draft and internal incidents as unknown", () => {
  const { store, events } = setup();
  const draftId = store.createDraft(draftBody()).id;
  const internalId = store.createDraft(draftBody({ visibility: "internal" })).id;
  store.publish(internalId);
  expect(events).toEqual([]);
  for (const id of [draftId, internalId]) {
    const before = internal(store, id);
    expect(store.get(id)).toBeUndefined();
    expect(() => store.addUpdate(id, { status: "monitoring", message: "x" })).toThrow(
      ManualIncidentNotFoundError,
    );
    expect(() => store.resolve(id, undefined)).toThrow(ManualIncidentNotFoundError);
    expect(() => store.remove(id)).toThrow(ManualIncidentNotFoundError);
    expect(internal(store, id)).toEqual(before);
  }
  expect(store.list("all")).toEqual([]);
  expect(store.listInternal("all").map((i) => i.id)).toEqual([internalId, draftId]);
});

test("an internal incident never fires a public event, a public one fires once each", () => {
  const { store, events } = setup();
  const internalId = store.createDraft(draftBody({ visibility: "internal" })).id;
  store.publish(internalId);
  store.saveDraftUpdate(internalId, { status: "resolved", message: "r" });
  expect(store.publish(internalId).status).toBe("resolved");
  store.addNote(internalId, { message: "n" }, ACTOR);
  store.removeAny(internalId);
  expect(events).toEqual([]);
  const publicId = store.createDraft(draftBody()).id;
  store.editDraft(publicId, draftBody({ title: "T2" }));
  expect(events).toEqual([]);
  store.publish(publicId);
  expect(events).toEqual(["created"]);
  store.resolve(publicId, undefined);
  expect(events).toEqual(["created", "resolved"]);
});

test("notes are private, ordered, limited, and never change the published timeline", () => {
  const { store, setClock } = setup();
  setClock(1000);
  const id = store.create(legacyBody).id;
  const publicBefore = store.get(id);
  setClock(2000);
  const withNote = valid(store.addNote(id, { message: "N-sentinel" }, ACTOR));
  expect(withNote.notes).toEqual([
    { id: expect.any(Number), at: 2000, author: "ops", message: "N-sentinel" },
  ]);
  expect(store.get(id)).toEqual(publicBefore);
  expect(JSON.stringify(store.list("all"))).not.toContain("N-sentinel");
  const noteId = withNote.notes[0]?.id ?? 0;
  expect(() => store.deleteNote(id, noteId + 1)).toThrow("note not found");
  const other = store.createDraft(draftBody()).id;
  expect(() => store.deleteNote(other, noteId)).toThrow("note not found");
  store.deleteNote(id, noteId);
  expect(internal(store, id).notes).toEqual([]);
  expect(() => store.addNote(id, { message: "a\u0007b" }, ACTOR)).toThrow(ManualIncidentInputError);
  for (let i = 0; i < 100; i++) store.addNote(id, { message: `n${i}` }, ACTOR);
  expect(() => store.addNote(id, { message: "one more" }, ACTOR)).toThrow(
    "manual incident has the most notes it takes (100)",
  );
  expect(internal(store, id).notes).toHaveLength(100);
});

test("at most 100 drafts and 100 published updates", () => {
  const { store } = setup();
  for (let i = 0; i < 100; i++) store.createDraft(draftBody());
  expect(() => store.createDraft(draftBody())).toThrow("too many draft incidents (100)");
  const id = store.create(legacyBody).id;
  store.saveDraftUpdate(id, { status: "monitoring", message: "D" });
  for (let i = 1; i < 99; i++) store.addUpdate(id, { status: "monitoring", message: `u${i}` });
  expect(store.publish(id).updates).toHaveLength(100);
  expect(() => store.saveDraftUpdate(id, { status: "monitoring", message: "x" })).toThrow(
    "manual incident has the most updates it takes (100)",
  );
  const other = store.create(legacyBody).id;
  store.saveDraftUpdate(other, { status: "monitoring", message: "D" });
  for (let i = 1; i < 100; i++) store.addUpdate(other, { status: "monitoring", message: `u${i}` });
  expect(() => store.publish(other)).toThrow(ManualIncidentConflictError);
  expect(store.get(other)?.updates).toHaveLength(100);
});

test("draft input: strict, visibility required, no resolved status, known components", () => {
  const { store } = setup();
  const bad = [
    { visibility: undefined },
    { visibility: "private" },
    { status: "resolved" },
    { draft: true },
    { title: "x".repeat(201) },
    { message: "x".repeat(2001) },
  ];
  for (const over of bad) {
    expect(() => store.createDraft(draftBody(over))).toThrow(ManualIncidentInputError);
  }
  expect(() => store.createDraft(draftBody({ componentIds: ["nope"] }))).toThrow(
    'componentIds: unknown component "nope"',
  );
  expect(store.listInternal("all")).toEqual([]);
});

test("publish checks components again; only published incidents block a component", () => {
  const { store, components } = setup();
  const id = store.createDraft(draftBody({ componentIds: ["db"] })).id;
  expect(store.hasOpenIncidentFor("db")).toBe(false);
  components.delete("db");
  let caught: unknown;
  try {
    store.publish(id);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ManualIncidentConflictError);
  expect((caught as Error).message).toBe('componentIds: unknown component "db"');
  expect(internal(store, id).publishedAt).toBeNull();
  store.editDraft(id, draftBody({ componentIds: ["web"], visibility: "internal" }));
  store.publish(id);
  expect(store.hasOpenIncidentFor("web")).toBe(true);
  store.saveDraftUpdate(id, { status: "resolved", message: "r" });
  store.publish(id);
  expect(store.hasOpenIncidentFor("web")).toBe(false);
});

test("a failing audit insert rolls every write back and fires no event", () => {
  const env = setup();
  const { store, events, setAuditDown, db } = env;
  const pubId = store.create(legacyBody, ACTOR).id;
  const draftId = store.createDraft(draftBody(), ACTOR).id;
  store.saveDraftUpdate(pubId, { status: "resolved", message: "r" }, ACTOR);
  const noteId = store.addNote(pubId, { message: "n" }, ACTOR).notes[0]?.id ?? 0;
  events.length = 0;
  const snapshot = (): unknown =>
    [
      "manual_incidents",
      "manual_incident_updates",
      "manual_incident_drafts",
      "manual_incident_notes",
    ].map((t) => db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const before = snapshot();
  setAuditDown(true);
  const writes: (() => unknown)[] = [
    () => store.createDraft(draftBody(), ACTOR),
    () => store.editDraft(draftId, draftBody({ title: "X" }), ACTOR),
    () => store.publish(draftId, ACTOR),
    () => store.publish(pubId, ACTOR),
    () => store.saveDraftUpdate(pubId, { status: "monitoring", message: "m" }, ACTOR),
    () => store.discardDraftUpdate(pubId, ACTOR),
    () => store.addNote(pubId, { message: "n2" }, ACTOR),
    () => store.deleteNote(pubId, noteId, ACTOR),
    () => store.removeAny(draftId, ACTOR),
    () => store.create(legacyBody, ACTOR),
    () => store.resolve(pubId, undefined, ACTOR),
  ];
  for (const write of writes) expect(write).toThrow("audit down");
  expect(snapshot()).toEqual(before);
  expect(events).toEqual([]);
});

test("audit actions of the private writes", () => {
  const { store, audits } = setup();
  const id = store.createDraft(draftBody(), ACTOR).id;
  store.editDraft(id, draftBody(), ACTOR);
  store.publish(id, ACTOR);
  store.saveDraftUpdate(id, { status: "monitoring", message: "m" }, ACTOR);
  store.discardDraftUpdate(id, ACTOR);
  const noteId = store.addNote(id, { message: "n" }, ACTOR).notes[0]?.id ?? 0;
  store.deleteNote(id, noteId, ACTOR);
  store.removeAny(id, ACTOR);
  expect(audits.map((a) => a.action)).toEqual([
    "manual-incident.create",
    "manual-incident.edit",
    "manual-incident.publish",
    "manual-incident.draft-save",
    "manual-incident.draft-discard",
    "manual-incident.note-add",
    "manual-incident.note-delete",
    "manual-incident.delete",
  ]);
  for (const a of audits) {
    expect(a.target).toEqual({ kind: "manual-incident", id: String(id) });
    expect(a.revision).toBeNull();
  }
});

test("the public resolved list filters before its limit of 50", () => {
  const { store, setClock } = setup();
  setClock(10 * DAY);
  const publicId = store.create(legacyBody).id;
  store.resolve(publicId, undefined);
  for (let i = 0; i < 50; i++) {
    setClock(10 * DAY + 1000 + i);
    const id = store.createDraft(draftBody({ visibility: "internal" })).id;
    store.publish(id);
    store.saveDraftUpdate(id, { status: "resolved", message: "r" });
    store.publish(id);
  }
  expect(store.list("resolved").map((i) => i.id)).toEqual([publicId]);
  expect(store.listInternal("resolved")).toHaveLength(50);
  expect(store.listInternal("resolved").map((i) => i.id)).not.toContain(publicId);
});

test("the public open list orders by publication time, the private list by creation", () => {
  const { store, setClock } = setup();
  setClock(100);
  const early = store.createDraft(draftBody()).id;
  setClock(200);
  const late = store.create(legacyBody).id;
  setClock(300);
  store.publish(early);
  expect(store.list("open").map((i) => i.id)).toEqual([early, late]);
  expect(store.listInternal("open").map((i) => i.id)).toEqual([late, early]);
  expect(store.get(early)?.createdAt).toBe(300);
  expect(internal(store, early).createdAt).toBe(100);
});

test("delete and retention remove updates, drafts and notes by cascade", () => {
  const { store, db, setClock } = setup();
  const count = (table: string): number =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  setClock(1000);
  const old = store.create(legacyBody).id;
  store.addNote(old, { message: "n" }, ACTOR);
  store.resolve(old, undefined);
  const draft = store.createDraft(draftBody()).id;
  store.addNote(draft, { message: "n" }, ACTOR);
  expect(count("manual_incident_notes")).toBe(2);
  store.deleteResolvedBefore(2000);
  expect(count("manual_incidents")).toBe(1);
  expect(count("manual_incident_notes")).toBe(1);
  store.removeAny(draft);
  expect(count("manual_incident_notes")).toBe(0);
  expect(count("manual_incident_drafts")).toBe(0);
  expect(count("manual_incident_updates")).toBe(0);
  expect(() => store.removeAny(draft)).toThrow(ManualIncidentNotFoundError);
});
