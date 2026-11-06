import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type ResendCommand,
  type ResendCommandState,
  SERVICE_REPORT_STALE_MS,
  type StatusSettings,
} from "@lorenzh/pulse-contract";

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

/** A stored `requestId` and the command it was answered with. */
export interface StoredResendRequest {
  requestId: string;
  commandId: string;
  channelId: string;
  key: string;
  createdAt: number;
}

/** The SQL of `resend_commands` and `resend_requests`; call the writes inside a transaction. */
export interface ResendStore {
  request(requestId: string): StoredResendRequest | null;
  command(id: string): ResendCommand | null;
  /** The open (`queued`, `claimed`, `admitted`) command of a delivery, or null. */
  openCommandFor(channelId: string, key: string): ResendCommand | null;
  requestCount(): number;
  commandCount(): number;
  /** Delete the finished command with the smallest `updatedAt`, then `id`; false when none. */
  deleteOldestFinished(): boolean;
  insertCommand(command: ResendCommand): void;
  insertRequest(request: StoredResendRequest): void;
  /** Requeue claims at least `timeoutMs` old, then claim up to `limit` oldest queued commands. */
  claim(now: number, timeoutMs: number, limit: number): ResendCommand[];
  setState(id: string, state: ResendCommandState, now: number): void;
  /** Delete commands and request rows whose own `createdAt` is before `cutoff`; the count. */
  deleteCreatedBefore(cutoff: number): number;
}

interface CommandRow {
  id: string;
  request_id: string;
  channel_id: string;
  key: string;
  state: string;
  created_at: number;
  updated_at: number;
}

const COMMAND_COLUMNS = "id, request_id, channel_id, key, state, created_at, updated_at";
const OPEN_STATES = "('queued', 'claimed', 'admitted')";

function commandOf(r: CommandRow): ResendCommand {
  return {
    id: r.id,
    channelId: r.channel_id,
    key: r.key,
    requestId: r.request_id,
    // Only contract states are stored.
    state: r.state as ResendCommandState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createResendStore(db: Database): ResendStore {
  const count = (table: string): number =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
  return {
    request(requestId) {
      const r = db
        .query<
          {
            request_id: string;
            command_id: string;
            channel_id: string;
            key: string;
            created_at: number;
          },
          [string]
        >(
          "SELECT request_id, command_id, channel_id, key, created_at FROM resend_requests WHERE request_id = ?",
        )
        .get(requestId);
      return r === null
        ? null
        : {
            requestId: r.request_id,
            commandId: r.command_id,
            channelId: r.channel_id,
            key: r.key,
            createdAt: r.created_at,
          };
    },
    command(id) {
      const r = db
        .query<CommandRow, [string]>(`SELECT ${COMMAND_COLUMNS} FROM resend_commands WHERE id = ?`)
        .get(id);
      return r === null ? null : commandOf(r);
    },
    openCommandFor(channelId, key) {
      const r = db
        .query<CommandRow, [string, string]>(
          `SELECT ${COMMAND_COLUMNS} FROM resend_commands
           WHERE channel_id = ? AND key = ? AND state IN ${OPEN_STATES}
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(channelId, key);
      return r === null ? null : commandOf(r);
    },
    requestCount: () => count("resend_requests"),
    commandCount: () => count("resend_commands"),
    deleteOldestFinished() {
      return (
        db.run(
          `DELETE FROM resend_commands WHERE id = (
             SELECT id FROM resend_commands WHERE state NOT IN ${OPEN_STATES}
             ORDER BY updated_at, id LIMIT 1)`,
        ).changes > 0
      );
    },
    insertCommand(c) {
      db.run(
        `INSERT INTO resend_commands (${COMMAND_COLUMNS}, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [c.id, c.requestId, c.channelId, c.key, c.state, c.createdAt, c.updatedAt],
      );
    },
    insertRequest(r) {
      db.run(
        `INSERT INTO resend_requests (request_id, command_id, channel_id, key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [r.requestId, r.commandId, r.channelId, r.key, r.createdAt],
      );
    },
    claim(now, timeoutMs, limit) {
      db.run(
        `UPDATE resend_commands SET state = 'queued', claimed_at = NULL, updated_at = ?
         WHERE state = 'claimed' AND claimed_at <= ?`,
        [now, now - timeoutMs],
      );
      const ids = db
        .query<{ id: string }, [number]>(
          "SELECT id FROM resend_commands WHERE state = 'queued' ORDER BY created_at, id LIMIT ?",
        )
        .all(limit)
        .map((r) => r.id);
      const claimed: ResendCommand[] = [];
      for (const id of ids) {
        db.run(
          "UPDATE resend_commands SET state = 'claimed', claimed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, id],
        );
        const c = this.command(id);
        if (c !== null) claimed.push(c);
      }
      return claimed;
    },
    setState(id, state, now) {
      db.run("UPDATE resend_commands SET state = ?, updated_at = ? WHERE id = ?", [state, now, id]);
    },
    deleteCreatedBefore(cutoff) {
      return db.transaction(
        () =>
          db.run("DELETE FROM resend_commands WHERE created_at < ?", [cutoff]).changes +
          db.run("DELETE FROM resend_requests WHERE created_at < ?", [cutoff]).changes,
      )();
    },
  };
}
