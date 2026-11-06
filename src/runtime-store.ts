import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { SERVICE_REPORT_STALE_MS, type StatusSettings } from "@lorenzh/pulse-contract";

/** A service that reports to the api over `/service/<name>/report`. */
export type ReportingService = "status" | "notify";

/** The last report of a service, kept as the validated JSON text, and the api time it arrived. */
export interface StoredReport {
  json: string;
  receivedAt: number;
}

/** The state of a stored report at `now`: `never` without one, `stale` after 180 000 ms. */
export type ReportState = "fresh" | "stale" | "never";

export interface RuntimeStore {
  /** The generation of `resource`; only configuration writes bump it. */
  generation(resource: ReportingService): number;
  /** Add one to the generation of `resource` and return the new value. Call inside a transaction. */
  bumpGeneration(resource: ReportingService): number;
  /** The stored status settings; `{}` before the first save. */
  statusSettings(): StatusSettings;
  /** Replace the whole status settings document. */
  replaceStatusSettings(settings: StatusSettings): void;
  /** The last report of `service`, or null when it never reported. */
  report(service: ReportingService): StoredReport | null;
  /** Replace the last report of `service`; the JSON must be validated already. */
  replaceReport(service: ReportingService, report: StoredReport): void;
  /** Every database notify channel, in creation order. */
  notifyChannels(): StoredChannel[];
  /** Insert a new channel; the id must be free. */
  insertNotifyChannel(channel: StoredChannel): void;
  /** Replace the definition of an existing channel; keeps its place and `createdAt`. */
  replaceNotifyChannel(id: string, definitionJson: string, updatedAt: number): void;
  /** Delete a channel; true when it existed. */
  deleteNotifyChannel(id: string): boolean;
}

/** A database notify channel: its validated definition as JSON text and its times. */
export interface StoredChannel {
  id: string;
  definitionJson: string;
  createdAt: number;
  updatedAt: number;
}

/** `sha256-` + hex SHA-256 of `<resource>\n<generation>`: independent of the check revision. */
export function runtimeRevision(resource: ReportingService, generation: number): string {
  const hex = createHash("sha256").update(`${resource}\n${generation}`).digest("hex");
  return `sha256-${hex}`;
}

/** Fresh up to and including 180 000 ms after `receivedAt`, stale after it. */
export function reportState(report: StoredReport | null, now: number): ReportState {
  if (report === null) return "never";
  return now - report.receivedAt <= SERVICE_REPORT_STALE_MS ? "fresh" : "stale";
}

const COLUMN: Record<ReportingService, string> = {
  status: "status_generation",
  notify: "notify_generation",
};

export function createRuntimeStore(db: Database): RuntimeStore {
  const generationOf = (resource: ReportingService): number => {
    const row = db
      .query<Record<string, number>, []>(`SELECT ${COLUMN[resource]} AS n FROM runtime_state`)
      .get();
    return row?.n ?? 0;
  };
  return {
    generation: generationOf,
    bumpGeneration(resource) {
      const column = COLUMN[resource];
      db.run(`UPDATE runtime_state SET ${column} = ${column} + 1 WHERE id = 1`);
      return generationOf(resource);
    },
    statusSettings() {
      const row = db
        .query<{ settings_json: string }, []>("SELECT settings_json FROM status_settings")
        .get();
      if (row === null) return {};
      // Only validated documents are stored.
      return JSON.parse(row.settings_json) as StatusSettings;
    },
    replaceStatusSettings(settings) {
      db.run(
        `INSERT INTO status_settings (id, settings_json) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json`,
        [JSON.stringify(settings)],
      );
    },
    report(service) {
      const row = db
        .query<{ report_json: string; received_at: number }, [string]>(
          "SELECT report_json, received_at FROM service_reports WHERE service = ?",
        )
        .get(service);
      return row === null ? null : { json: row.report_json, receivedAt: row.received_at };
    },
    replaceReport(service, report) {
      db.run(
        `INSERT INTO service_reports (service, report_json, received_at) VALUES (?, ?, ?)
         ON CONFLICT (service) DO UPDATE SET report_json = excluded.report_json,
           received_at = excluded.received_at`,
        [service, report.json, report.receivedAt],
      );
    },
    notifyChannels() {
      return db
        .query<{ id: string; definition_json: string; created_at: number; updated_at: number }, []>(
          "SELECT id, definition_json, created_at, updated_at FROM notify_channels ORDER BY seq",
        )
        .all()
        .map((r) => ({
          id: r.id,
          definitionJson: r.definition_json,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
    },
    insertNotifyChannel(c) {
      db.run(
        `INSERT INTO notify_channels (id, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [c.id, c.definitionJson, c.createdAt, c.updatedAt],
      );
    },
    replaceNotifyChannel(id, definitionJson, updatedAt) {
      db.run("UPDATE notify_channels SET definition_json = ?, updated_at = ? WHERE id = ?", [
        definitionJson,
        updatedAt,
        id,
      ]);
    },
    deleteNotifyChannel(id) {
      return db.run("DELETE FROM notify_channels WHERE id = ?", [id]).changes > 0;
    },
  };
}
