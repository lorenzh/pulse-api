# REST API

The API serves JSON over HTTP. The types come from [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md).

## Overview

| Method                         | Path                                                                                  | Auth                    | Response                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `POST`                         | `/results`                                                                            | probe token             | `204`, no body                                                                    |
| `GET`                          | `/probe/checks`                                                                       | probe token             | `Check[]` (active checks as configured)                                           |
| `GET`                          | `/checks`                                                                             | none                    | `ChecksResponse` (`CheckWithState[]`)                                             |
| `GET`                          | `/checks/:id/results`                                                                 | none                    | `ResultsResponse` (`Result[]`)                                                    |
| `GET`                          | `/uptime`                                                                             | none                    | `UptimeResponse` (`CheckUptime[]`)                                                |
| `GET`                          | `/latency`                                                                            | none                    | `LatencyResponse` (`CheckLatency[]`)                                              |
| `GET`                          | `/checks/:id/latency`                                                                 | none                    | `CheckLatency`                                                                    |
| `GET`                          | `/checks/:id/location-uptime`                                                         | none                    | `CheckLocationUptime`                                                             |
| `GET`                          | `/components`                                                                         | none                    | `ComponentsResponse` (`ComponentWithState[]`)                                     |
| `GET`                          | `/components/uptime`                                                                  | none                    | `ComponentsUptimeResponse` (`ComponentUptime[]`)                                  |
| `GET`                          | `/incidents`                                                                          | none                    | `IncidentsResponse` (`Incident[]`)                                                |
| `GET`                          | `/maintenance`                                                                        | none                    | `MaintenanceResponse` (`MaintenanceWindow[]`)                                     |
| `GET`                          | `/locations`                                                                          | none                    | see [GET /locations](#get-locations)                                              |
| `GET`                          | `/manual-incidents`, `/manual-incidents/:id`                                          | none                    | see [GET /manual-incidents](#get-manual-incidents)                                |
| `POST`                         | `/manual-incidents`, `/manual-incidents/:id/updates`, `/manual-incidents/:id/resolve` | `admin` and `incidents` | see [Write routes](#write-routes)                                                 |
| `DELETE`                       | `/manual-incidents/:id`                                                               | `admin` and `incidents` | see [Write routes](#write-routes)                                                 |
| `GET`, `POST`, `PUT`, `DELETE` | `/admin/manual-incidents[/:id[/draft\|/publish\|/notes[/:noteId]]]`                   | `admin` and `incidents` | see [Private routes](#private-routes)                                             |
| `GET`, `POST`                  | `/heartbeat/:id[/:secret]`                                                            | Heartbeat secret        | `204`, no body; `401` for a wrong secret or unknown id                            |
| `GET`                          | `/healthz`                                                                            | none                    | `200 ok` (liveness, `text/plain`)                                                 |
| `GET`                          | `/readyz`                                                                             | none                    | `200 ok` or `503` with a reason (`text/plain`)                                    |
| `GET`                          | `/metrics`                                                                            | none                    | Prometheus text                                                                   |
| `GET`                          | `/admin/config`                                                                       | `read` or `checks`      | see [Admin config routes](#admin-config-routes)                                   |
| `GET`                          | `/admin/maintenance`                                                                  | `read` or `checks`      | `AdminMaintenanceList`, see [Admin maintenance routes](#admin-maintenance-routes) |
| `POST`, `PUT`, `DELETE`        | `/admin/checks[/:id]`, `/admin/components[/:id]`, `/admin/maintenance[/:id]`          | `admin` and `checks`    | see [Admin config routes](#admin-config-routes)                                   |
| `GET`, `POST`                  | `/admin/tokens[/self\|/:id[/…]]`                                                      | `admin`                 | see [Tokens](#tokens)                                                             |
| `GET`                          | `/admin/audit[/export]`                                                               | `admin`                 | see [Audit log](#audit-log)                                                       |
| `GET`, `PUT`                   | `/admin/status/settings`                                                              | `admin`                 | see [Status settings](#status-settings)                                           |
| `GET`                          | `/service/status/settings`                                                            | only `status`           | see [Status settings](#status-settings)                                           |
| `PUT`                          | `/service/status/report`                                                              | only `status`           | see [Status settings](#status-settings)                                           |

General rules:

- Errors have the body `{"error": "<message>"}` (`ErrorResponse`).
- A request target that is not a valid URL path (for example `//[`) gives `400` with `invalid request target`, on every path and method, before auth. The body never repeats the target, and nothing is logged.
- Admin routes (`/admin/*`, including `/admin/manual-incidents`, and the manual-incident writes) give `429` with `too many requests` and `Retry-After` when the client failed admin authentication too often. See [Admin auth throttle](#admin-auth-throttle).
- An unknown path gives `404` with `not found`. Another method on a known path gives `405` with `method not allowed` and the header `Allow` with the allowed methods (for example `Allow: GET`).
- The public reads (`/checks`, `/checks/:id/*`, `/uptime`, `/latency` and the others marked `GET` above) serve only `GET`. `HEAD` and every other method answer `405` with `Allow: GET`, before the id is looked up; the body is `{"error":"method not allowed"}`, empty for `HEAD`.
- Per-id routes cannot address the check ids `.` and `..`: the path is normalized before routing, so `/checks/%2E/location-uptime` answers `404` `not found` and `/checks/../results` is the path `/results`.
- A request body over 1,000,000 bytes gives `413` with `request body too large`.
- An unexpected failure gives `500` with `internal error`. The cause is written to stderr.
- Timestamps are epoch milliseconds.
- The public reads (auth `none` above) need no token. `/probe/checks`, `/results`, every `/admin/*` route and the manual-incident writes need one. Keep the API on a private network and publish only the heartbeat route: see [Network exposure](install.md#network-exposure).

## POST /results

A probe posts one result. The body is a `Result` (`PostResultRequest`).

Headers: `Authorization: Bearer <token>` (the word `Bearer` is case-insensitive, then one space and a non-empty token).

| Field          | Type                           | Rule                                                                                                                                                                                              |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkId`      | string                         | Non-empty. Must be a configured check.                                                                                                                                                            |
| `timestamp`    | integer                        | Epoch ms, set by the probe. At most `min(intervalMs of the check, 60000)` ms after the API clock (60000 for heartbeat checks and unknown ids) and at most 7 days (`MAX_RESULT_AGE_MS`) before it. |
| `status`       | `"up"`, `"degraded"`, `"down"` | Required.                                                                                                                                                                                         |
| `statusCode`   | integer or `null`              | Required. `null` when no response arrived, else 100 to 599.                                                                                                                                       |
| `latencyMs`    | number                         | Integer 0..2147483647 (`MAX_LATENCY_MS`). A finite fraction `>= 0` is rounded to the nearest integer before validation, for older probes. Served results carry integers.                          |
| `reason`       | string or `null`               | Required. At most 1000 UTF-16 code units (`MAX_REASON_LENGTH`).                                                                                                                                   |
| `location`     | string                         | Optional. Trimmed, at most 64 characters. Blank means the token's location.                                                                                                                       |
| `attempts`     | integer                        | Optional, 1 to 100 (`MAX_ATTEMPTS`). A missing value is stored as 1.                                                                                                                              |
| `certDaysLeft` | integer or `null`              | Optional. For TLS checks (certificate) and domain checks (registration expiry, negative when expired). From −3000000 to 3000000 (`MAX_CERT_DAYS`), which covers an expiry in year 9999.           |

The checks run in this order:

1. `405` if the method is not `POST`.
2. `401` `{"error":"unauthorized"}` with header `WWW-Authenticate: Bearer` for a missing, malformed or unknown token.
3. `413` if the body is too large.
4. `400` `body is not valid JSON`.
5. `400` with the first failing field message. The body is first checked by the contract validator `validatePostResultRequest`, whose messages name the path, for example `result.status: must be one of "up", "degraded", "down"`. Then the api checks run: timestamp window, `latencyMs`, `reason` length, `attempts` and `location`. The messages are listed in [Troubleshooting](troubleshooting.md#400-on-post-results).
6. `403` `heartbeat checks accept only pings` if `checkId` names an active heartbeat check. Only a [ping](#getpost-heartbeatidsecret) changes such a check; nothing is stored.
7. `403` `location does not match token` if the body has a `location` that differs from the token's location (after trim).
8. `404` `unknown check "<id>"` (also for a check removed from the configuration).
9. `204` and the result is stored. The stored location is always the token's.

Every message names the field, for example `timestamp is more than 60000 ms in the future` or `timestamp is older than 7 days`. Nothing is stored when a request is rejected.

A result older than the newest stored result of the same check (any location) never changes the state, the counter, the incidents or `lastResultAt`; it is stored and listed in the results history (see [Late results](concepts.md#late-results)). Rows stored earlier with a future timestamp are not cleaned up; an operator can delete them from the `results` table.

`POST /results` is idempotent on (check, location, timestamp). The same result posted again answers `204` like the first time, stores no row, and changes no state, counter, incident, metric or location time. The first post wins: a repeat with other values is ignored. A probe can therefore re-send buffered results after a lost answer. (Heartbeat pings and missed-ping results are made by the API itself; two in the same millisecond are both kept, the second one millisecond later. A result posted to `POST /results` for a heartbeat check follows the rule above.)

Every response carries the headers `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` `Referrer-Policy: no-referrer` and `x-pulse-contract: <WIRE_VERSION>` (the wire-format version of the contract, `1` today). The result triggers one evaluation (see [Quorum and incidents](concepts.md#quorum-and-incidents)).

Example (`PULSE_PROBE_TOKEN` holds the token of the `tokens.json` entry `east`, and `checks.json` has a check `example`):

```sh
curl -i -X POST http://localhost:3000/results \
  -H "Authorization: Bearer $PULSE_PROBE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"checkId":"example","timestamp":'"$(date +%s)000"',"status":"down","statusCode":503,"latencyMs":12,"reason":"HTTP 503"}'
```

The response is `HTTP/1.1 204 No Content`. A request with an old fixed `timestamp` fails with `400`, so the example takes the current time.

## GET /checks

Returns every active check (checks removed from the configuration, the file and the database checks, are left out) in database rowid order (the order in which the checks were first inserted, not the order of the checks file) with its state (`CheckWithState[]`): the check fields plus `state`, `consecutiveDown`, `lastResultAt`, `lastReason`, `locations`, and when set `maintenance` and `certDaysLeft`. `retries` and `retryDelayMs` are always present for HTTP checks. `timeoutMs`, `latencyObjectiveMs` and `keyword` are present when configured. `method` and `expectedStatus` are present only when they are not the defaults (`GET`, `200-299`). `headers`, `body` and `jsonAssert` are never served here: see [GET /probe/checks](#get-probechecks). `locations` has one `{ location, result, stale }` per location ever seen, sorted by name, and is empty for a check without results.

```sh
curl http://localhost:3000/checks
```

```json
[
  {
    "id": "example",
    "name": "Example endpoint",
    "url": "http://localhost:9000/",
    "intervalMs": 10000,
    "retries": 2,
    "retryDelayMs": 500,
    "state": "down",
    "consecutiveDown": 4,
    "lastResultAt": 1793265326003,
    "lastReason": "HTTP 503",
    "locations": [
      {
        "location": "east",
        "result": {
          "checkId": "example",
          "timestamp": 1793265326003,
          "status": "down",
          "statusCode": 503,
          "latencyMs": 12,
          "reason": "HTTP 503",
          "location": "east",
          "attempts": 1
        },
        "stale": false
      }
    ],
    "timeoutMs": 1000,
    "latencyObjectiveMs": 500
  }
]
```

(The output above is shortened to the first check.)

## GET /probe/checks

Needs the probe `Authorization: Bearer <token>` header, like `POST /results`. Answers `401` without a valid token and `405` for other methods. Returns every active check as written in the checks file (`Check[]`), without state, including `method`, `headers`, `body`, `expectedStatus` and `jsonAssert`. `availabilityTarget` is omitted on purpose, even when the check has one: a probe does not need it, and an older probe would skip a check with a field it does not know. A header value `{"env": "NAME"}` is served as it is: the probe resolves it. Literal header values and bodies are served in clear text, so keep the probe tokens secret.

```sh
curl -H "Authorization: Bearer $PULSE_PROBE_TOKEN" http://localhost:3000/probe/checks
```

## GET /checks/:id/results

Returns the results of one check, newest first (`Result[]`).

| Query    | Meaning                                         |
| -------- | ----------------------------------------------- |
| `limit`  | Positive integer. Default 100, capped at 1000.  |
| `before` | Epoch ms, exclusive cursor: only older results. |

To page, request the next page with `before` set to the `timestamp` of the last item. A page that ends inside a group of results with the same timestamp (one per location) returns the whole group, so it can exceed `limit`. A retried submission can store several rows for one location and timestamp, so a page can hold more rows than the number of locations (5 rows for `limit=1`). Nothing is skipped or repeated.

Errors: `400` `limit must be a positive integer`, `400` `before must be a non-negative integer`, `400` `bad check id` (malformed percent escape), `404` `unknown check "<id>"`.

```sh
curl 'http://localhost:3000/checks/example/results?limit=1'
```

## GET /locations

No token, `GET` only. Returns the probe locations that posted a result, sorted by name, as `Location[]` (`LocationsResponse`):

```json
[{ "name": "east", "lastResultAt": 1761652800000, "state": "reporting" }]
```

- `lastResultAt` is the newest timestamp (epoch ms) of an accepted result of the location. A late or replayed result never lowers it.
- `state` is `silent` when the API received no accepted result from the location for more than the silent threshold, else `reporting`. The rule uses the time the API received a result, not the result timestamp: a probe that replays buffered results with old timestamps is `reporting` as soon as it delivers. The threshold is `PULSE_LOCATION_SILENT_MS`, or `max(180000, 3 × the largest intervalMs of the active non-heartbeat checks)` when it is unset, evaluated at each read.
- The heartbeat pseudo location (`heartbeat`) is never listed. Rejected posts (`400`, `401`, `403`, `404`) do not count.
- The list is kept in memory. At start it is rebuilt from the newest stored result per location, so after a restart a location is `reporting` only for the rest of the threshold after its last stored result, and `silent` until its probe posts again. A location with no stored result is unknown until it posts.

## GET /uptime

Returns one `CheckUptime` per active check, in the order of `GET /checks`. Each has `checkId`, `days` and `uptime`. `days` has exactly 90 UTC calendar days, oldest first, and the last is today. A day has `date` (`YYYY-MM-DD`), `uptime` (percent, unrounded, `null` without results) and `results`. `uptime` is the result-weighted value over the window (`null` without results). Results before the window or after now are ignored. See [Uptime](concepts.md#uptime).

```sh
curl http://localhost:3000/uptime
```

## GET /latency

Returns one `CheckLatency` per active HTTP check, in the order of `GET /checks`. Each has `checkId` and `days`: exactly 90 UTC calendar days, oldest first, the last is today. A day has `date`, `p50Ms`, `p95Ms` (nearest-rank, `null` without results) and `count`. See [Latency history](concepts.md#latency-history-and-availability-objective).

```sh
curl http://localhost:3000/latency
```

## GET /checks/:id/latency

Returns the `CheckLatency` of one active HTTP check. An unknown or inactive id, and a check without latency (heartbeat, TLS, tcp, dns, domain), answer `404` with `unknown check`. A malformed id escape gives `400`. Same headers and read cache as the other reads.

## GET /checks/:id/location-uptime

Returns the `CheckLocationUptime` of one active check of any type: `{ checkId, windowDays: 90, locations: LocationUptime[] }`. `checkId` is the decoded id, `windowDays` is always `90`. The window is the one of `GET /uptime`: the 90 UTC days ending today, up to the API clock. The sample set is every stored result of the check in the window at that location, of any status; heartbeat results have the location `heartbeat`. For each location `good` counts the results that are not `down` (up and degraded), `results` counts all, and `uptime` is `good / results * 100`, unrounded, `null` exactly when `results` is `0`. Every location with a stored result of the check at any age is listed once, sorted by name in UTF-16 code-unit order; a location with only older results has `good` 0, `results` 0 and `uptime` null. See [Uptime](concepts.md#uptime).

An unknown or inactive id answers `404` with `unknown check`, a malformed id escape `400` with `bad check id`. No token is needed; an `Authorization` header is ignored. `HEAD` and every other method answer `405` with `Allow: GET`. Same headers and read cache as the other reads.

```sh
curl http://localhost:3000/checks/api/location-uptime
```

```json
{
  "checkId": "api",
  "windowDays": 90,
  "locations": [
    { "location": "eu", "good": 1, "results": 2, "uptime": 50 },
    { "location": "us", "good": 1, "results": 1, "uptime": 100 }
  ]
}
```

## GET /components

Returns one `ComponentWithState` per component of the checks file, in configured order, or `[]` without components. It carries the configured fields (`id`, `name`, `description`, `group`, `checkIds`) plus:

- `state`: the combined state of the member checks, including `maintenance`. First match wins: any `down` gives `down`; any `degraded` gives `degraded`; else, after dropping `maintenance` and `unknown`, any `up` gives `up`; else any `maintenance` gives `maintenance`; else `unknown`.
- `uptime`: the 90-day window value of `GET /components/uptime`, `null` when no member has results.
- `incidentIds`: ids of the open incidents of the member checks, ascending.
- `slo`: only with an `availabilityTarget`: `{target, windowDays: 30, availability, budgetRemaining}`, as in [Latency history](concepts.md#latency-history-and-availability-objective).

## GET /components/uptime

Returns one `ComponentUptime` (`componentId`, `days`, `uptime`) per component, in configured order. `days` has 90 UTC days, oldest first. A day's uptime is result-weighted over the member checks: `sum(up + degraded) / sum(results) * 100`, `null` with `results: 0` when no member has results that day. A check in several components counts in each. `GET /uptime` is unchanged.

## Read cache

`GET /checks`, `GET /uptime`, `GET /latency`, `GET /checks/:id/latency` and `GET /checks/:id/location-uptime` answers are reused for up to 5 s. Every ingest (`POST /results`, a heartbeat ping or expiry), a checks file load and every retention delete clears the cache, so a result is visible right after it is accepted. Recomputing after an ingest does not re-read today's results: today's uptime and latency are kept in memory and updated with each stored result. The TTL only bounds changes made by the clock; a maintenance window that opens or closes also ends a cached answer.

## GET /incidents

Returns incidents (`Incident[]`) with `id`, `checkId`, `openedAt`, `resolvedAt` (`null` while open) and `reason`. Open incidents come first, then the newest first.

| Query    | Meaning                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `status` | `open` or `resolved`. When omitted, both are returned.                                                       |
| `limit`  | Positive integer. Default 1000, capped at 5000.                                                              |
| `since`  | Epoch ms. Only incidents relevant at or after it: `openedAt >= since`, `resolvedAt >= since`, or still open. |

The default limit is large so that a reader without parameters (the status page) gets every incident in practice; with more than 1000 incidents, narrow with `since` or raise `limit`.

Errors: `400` `status must be "open" or "resolved"`, `400` `limit must be a positive integer`, `400` `since must be a non-negative integer`.

```sh
curl 'http://localhost:3000/incidents?status=open'
```

```json
[
  {
    "id": 1,
    "checkId": "example",
    "openedAt": 1793265326002,
    "resolvedAt": null,
    "reason": "HTTP 503"
  }
]
```

## GET /maintenance

Returns maintenance windows (`MaintenanceWindow[]`) with `end > now`, sorted by `start` and then `checkId`. A window is current when `start <= now` and upcoming otherwise. Windows are half-open: `[start, end)`.

| Query     | Meaning                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkId` | Optional filter on one check. An unknown id answers `404` `unknown check "<id>"` (like the results route; before, it answered an empty list). |

```sh
curl 'http://localhost:3000/maintenance?checkId=example'
```

```json
[
  {
    "checkId": "example",
    "start": 1893463200000,
    "end": 1893470400000,
    "note": "Planned database upgrade"
  }
]
```

## GET|POST /heartbeat/:id[/:secret]

Ping of a [heartbeat check](configuration.md#heartbeat-checks). Authenticate with the check's `secret`, either as `Authorization: Bearer <secret>` (preferred) or in the path as `/heartbeat/<id>/<secret>`. There is no query-string form. The `id` is URL-decoded as in `/checks/:id/results`.

| Status | Meaning                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| `204`  | Ping accepted, no body. For an inactive check the answer is `204` too, but nothing is recorded. |
| `401`  | Wrong or missing secret, or unknown id. All three answer alike (see below).                     |
| `405`  | Any method other than `GET` and `POST`.                                                         |
| `413`  | The request body is over 1 KB. A body is read and ignored.                                      |

The `401` body is always `{"error":"unauthorized"}` with `www-authenticate: Bearer`, so the existence of an id is not revealed.

A ping stores an `up` result with `location` `heartbeat`, `statusCode` null, `latencyMs` 0 and the API clock as `timestamp`. `lastResultAt` of the check is the time of the last ping. The path form puts the secret in the URL; see [Heartbeat checks](operation.md#heartbeat-checks).

## Manual incidents

Operators post incidents by hand, with timed updates. They sit beside the automatic incidents of `GET /incidents` and use their own ids. The shapes are `ManualIncident`, `ManualIncidentInput` and `ManualIncidentUpdateInput` of `@lorenzh/pulse-contract`.

A `ManualIncident` is `{id, title, componentIds, impact, status, createdAt, resolvedAt, updates}`. `impact` is `none`, `minor`, `major` or `critical` and is fixed at creation. `status` is `investigating`, `identified`, `monitoring` or `resolved`. `updates` is `{at, status, message}[]`, append-only and ordered by `at`; the index is the stable update number, and update 0 is the creation message. `resolvedAt` is set exactly when `status` is `resolved`. The server sets all times.

Limits: `title` 1 to 200 characters, `message` 1 to 2000, at most 100 updates per incident, at most 50 `componentIds`, body at most 16 KiB (`413` above). Text is plain: control characters (newline only in messages) are refused with `400`. HTML is stored as written; consumers must escape it. `componentIds` may be empty (a general incident); the ids must be unique and configured components, and with no components configured the list must be empty.

### GET /manual-incidents

Public, like the other reads. They serve only published `public` incidents: a draft or an `internal` incident is never listed, and its id answers the same `404` `{"error":"manual incident not found"}` (same status, body and headers apart from `Date`) as a deleted or unknown id. The public `createdAt` is the publication time. Ids are not contiguous; a gap can be a deleted or a private incident. The limit of 50 resolved incidents counts public incidents only. `?status=open|resolved|all` (default `all`): open incidents (newest created first), then incidents resolved within 14 days (newest first, at most 50). `resolved` returns only the second group. Another value answers `400`. `GET /manual-incidents/:id` answers one incident or `404`. Before the first admin import (see [Token import](configuration.md#token-import)) the feature is off: the list is empty and every id answers `404`, even when the database holds incidents.

### Write routes

All need `Authorization: Bearer <token>` of a token with the scopes `admin` and `incidents` (see [Scopes](#scopes)). A missing, unknown, expired, revoked or rotated-out token answers `401`. A probe token or a token without those scopes answers `403`. The `admin auth failed` log line tells them apart with `token` `missing`, `unknown`, `inactive`, `probe` or `scope`. Before the first admin import (see [admin-tokens.json](configuration.md#admin-tokensjson)) they answer `404` and log nothing.

Each write and its [audit entry](#audit-log) commit in one transaction, and the answer is sent after the commit. If the audit entry cannot be written, nothing changes and the answer is `500`.

Each successful write logs one `info` line `manual incident write` with the admin token name, the action and the id. A write that fails after authentication (`400`, `404`, `409`, `413`) logs one `warn` line `manual incident write failed` with the status, the action and, except for a create, the id. No title, message or body goes into a line. See [Logs](operation.md#logs).

| Route                                | Body                                                                                                      | Answer                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| `POST /manual-incidents`             | `title`, `impact`, `componentIds`, `message`, optional `status` (default `investigating`, not `resolved`) | `201` and the incident |
| `POST /manual-incidents/:id/updates` | `status` (may be `resolved`), `message`                                                                   | `201` and the incident |
| `POST /manual-incidents/:id/resolve` | optional `message` (default `Resolved.`)                                                                  | `200` and the incident |
| `DELETE /manual-incidents/:id`       | none                                                                                                      | `204`                  |

The legacy writes see only published `public` incidents. On a draft or an `internal` incident they answer `404 manual incident not found`, like an unknown id, and change nothing. `POST /manual-incidents` always publishes a `public` incident; a body with a `visibility` or `draft` key answers `400` (`visibility: not accepted here; use /admin/manual-incidents`). A legacy update on an incident with a pending draft update appends and keeps the draft; a resolving write discards the draft.

A resolved incident takes no update and no second resolve, and is never reopened: `409`. The same answer follows the 100th update. An unknown id answers `404`, invalid input `400`. Resolving by either route yields one resolution. `DELETE` is a hard delete: notifications that were sent cannot be retracted, and the incident leaves the status page and feeds. Resolved incidents are deleted after the retention window, like [resolved results](concepts.md#retention).

```sh
API=http://127.0.0.1:3000
TOKEN=$(cat /path/to/admin-token)   # a value from your admin tokens file
curl -sS -X POST "$API/manual-incidents" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Slow checkout","impact":"minor","componentIds":["web"],"message":"We are looking into it."}'
curl -sS -X POST "$API/manual-incidents/1/updates" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"identified","message":"Cause found."}'
curl -sS -X POST "$API/manual-incidents/1/resolve" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"message":"Fixed."}'
curl -sS -X DELETE "$API/manual-incidents/1" -H "Authorization: Bearer $TOKEN"
```

### Private routes

Drafts, internal notes and internal-only incidents live under `/admin/manual-incidents`. The shapes are `InternalManualIncident`, `ManualIncidentDraftInput`, `ManualIncidentUpdateInput` and `ManualIncidentNoteInput` of `@lorenzh/pulse-contract`. An `InternalManualIncident` adds `visibility` (`public` or `internal`), `publishedAt` (`null` while a draft), `draft` (`{status, message, savedAt}` or `null`) and `notes` (`{id, at, author, message}[]`) to the public fields; its `createdAt` is the first save. `author` is the name of the admin token that wrote the note.

Every route needs a token with `admin` and `incidents`, also when the config writes are off. Checks run in this order: unknown path or a bad id (not `^\d{1,15}$`, for the incident and the note id) `404`; wrong method `405` with `Allow`; before the first admin import `404`; then auth (`401` with `WWW-Authenticate: Bearer`, `403`, `429` from the shared [throttle](#admin-auth-throttle)); then the body (`413` over 16 KiB, also for ignored bodies; `400` for invalid JSON or fields); then existence (`404`); then state (`409`). A caller without a valid token never learns whether an id exists.

| Route                                              | Body                                                                                                   | Answer                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET /admin/manual-incidents[?status=…]`           | none                                                                                                   | `200`, drafts and open (newest created first), then resolved within 14 days (at most 50), both visibilities |
| `GET /admin/manual-incidents/:id`                  | none                                                                                                   | `200` and the incident                                                                                      |
| `POST /admin/manual-incidents`                     | `title`, `impact`, `componentIds`, `message`, `visibility`, optional `status` (not `resolved`); strict | `201` and the new draft incident                                                                            |
| `PUT /admin/manual-incidents/:id`                  | as for `POST`                                                                                          | `200`; replaces the fields of a draft incident                                                              |
| `DELETE /admin/manual-incidents/:id`               | ignored                                                                                                | `204`; deletes any incident with its updates, draft and notes                                               |
| `PUT /admin/manual-incidents/:id/draft`            | `status`, `message`                                                                                    | `200`; saves or replaces the draft update of a published, open incident                                     |
| `DELETE /admin/manual-incidents/:id/draft`         | ignored                                                                                                | `204`; discards the draft update                                                                            |
| `POST /admin/manual-incidents/:id/publish`         | ignored                                                                                                | `200` and the incident after publication                                                                    |
| `POST /admin/manual-incidents/:id/notes`           | `message`                                                                                              | `201` and the incident with the new note                                                                    |
| `DELETE /admin/manual-incidents/:id/notes/:noteId` | ignored                                                                                                | `204`                                                                                                       |

State rules. A draft incident has no published update; its status and message are its draft. Publishing it checks the components again, adds update 0 at the publication time and sets `publishedAt`; a public one then appears on the public reads and in `pulse_api_manual_incidents_created_total`. Publishing a draft update appends it at `max(now, last update)`; a `resolved` draft resolves the incident. `visibility` is fixed at publication. Notes are never public and never become updates. Fixed answers:

| Request                                    | State                         | Answer                                                     |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| `PUT …/:id`                                | published                     | `409 manual incident is published`                         |
| `PUT` or `DELETE …/:id/draft`              | draft incident                | `409 manual incident is a draft`                           |
| `PUT …/:id/draft`                          | resolved                      | `409 manual incident is resolved`                          |
| `PUT …/:id/draft`, `POST …/:id/publish`    | 100 published updates         | `409 manual incident has the most updates it takes (100)`  |
| `DELETE …/:id/draft`, `POST …/:id/publish` | published, no draft           | `409 manual incident has no draft` (also a second publish) |
| `POST …/:id/publish`                       | a component was removed       | `409 componentIds: unknown component "<id>"`               |
| `POST /admin/manual-incidents`             | 100 draft incidents           | `409 too many draft incidents (100)`                       |
| `POST …/:id/notes`                         | 100 notes                     | `409 manual incident has the most notes it takes (100)`    |
| `DELETE …/:id/notes/:noteId`               | no such note on this incident | `404 note not found`                                       |

Each write and its audit entry commit together. Writes log `manual incident write` with the actions `create-draft`, `edit`, `delete`, `save-draft`, `discard-draft`, `publish`, `add-note`, `delete-note`; reads are not logged. Requests to these paths are not counted in `pulse_api_http_requests_total`. Internal incidents are never sent to notify or any channel. Known limit: two operators that save and publish at the same time get the text stored when the publish commits; there is no revision check.

```sh
# A draft, edited, then published (201, 200, 200; a second publish answers 409).
curl -sS -X POST "$API/admin/manual-incidents" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Slow checkout","impact":"minor","componentIds":["web"],"message":"Looking.","visibility":"public"}'
curl -sS -X PUT "$API/admin/manual-incidents/2" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Slow checkout","impact":"major","componentIds":["web"],"message":"Looking into it.","visibility":"public"}'
curl -sS -X POST "$API/admin/manual-incidents/2/publish" -H "Authorization: Bearer $TOKEN"
# A draft update, then its publication (200, 200).
curl -sS -X PUT "$API/admin/manual-incidents/2/draft" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"resolved","message":"Fixed."}'
curl -sS -X POST "$API/admin/manual-incidents/2/publish" -H "Authorization: Bearer $TOKEN"
# An internal note (201).
curl -sS -X POST "$API/admin/manual-incidents/2/notes" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"message":"Rolled back release 41."}'
# An internal-only incident: published (200), but GET /manual-incidents/3 answers 404.
curl -sS -X POST "$API/admin/manual-incidents" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Replica lag","impact":"none","componentIds":[],"message":"Watching.","visibility":"internal"}'
curl -sS -X POST "$API/admin/manual-incidents/3/publish" -H "Authorization: Bearer $TOKEN"
curl -sS -X GET "$API/admin/manual-incidents/3" -H "Authorization: Bearer $TOKEN"
```

`GET /components` is unchanged: it does not apply manual incidents. The status page maps an open incident's impact to the state of its components (`minor` to `degraded`, `major` and `critical` to `down`) with `incidentImpactState` of the contract.

## Admin config routes

Operators change checks, components and maintenance windows through the API. A check write stores a database check (see [Changing checks](operation.md#changing-checks)); a component write rewrites the checks file and the API applies it at once; a window write stores a database window (see [Admin maintenance routes](#admin-maintenance-routes)). The effective checks are the applied file checks, then the database checks the file does not shadow. The shapes are `AdminConfigResponse`, `AdminCheckInput`, `AdminCheckView`, `AdminComponent`, `AdminMaintenanceView`, `AdminMaintenanceWindowInput`, `AdminMaintenanceWindow` and `AdminMaintenanceList` of `@lorenzh/pulse-contract`. The routes need the admin import (see [admin-tokens.json](configuration.md#admin-tokensjson)) and `Authorization: Bearer <token>`: `GET /admin/config` needs `read` or `checks`, a write needs `admin` and `checks` (see [Scopes](#scopes)).

| Route                                                                   | Answer                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /admin/config`                                                     | `200` `{revision, checks, shadowed, components, maintenance, file}`, with an `ETag` |
| `GET /admin/config/export`                                              | `200` the effective checks as a checks file (`AdminConfigExport`), see below        |
| `POST /admin/checks`                                                    | `201`, the check view, a `Location` header; an id in the file or stored `409`       |
| `PUT /admin/checks/:id`                                                 | `200`, full replace of a database check; file or shadowed id `409`; unknown `404`   |
| `DELETE /admin/checks/:id`                                              | `204` for a database check, also a shadowed one; a file-only id `409`               |
| `POST /admin/components`, `PUT`/`DELETE /admin/components/:id`          | like checks; deleting a component with an unresolved manual incident answers `409`  |
| `GET`, `POST /admin/maintenance`, `PUT`/`DELETE /admin/maintenance/:id` | database windows, see [Admin maintenance routes](#admin-maintenance-routes)         |

The **revision** is `sha256-` and the hex SHA-256 of `<applied file revision>\n<database generation>`, where the file revision is `sha256-<hex>` of the bytes of the applied file and the generation rises by one per committed check or window write. A rejected or unread file does not change it. It is sent as a quoted `ETag` and as `revision` in bodies. Every write needs `If-Match: "<revision>"`: missing gives `428`, stale gives `412`, `*` or a malformed value gives `400`. Every success carries the new `ETag`.

Statuses, in the order the API decides them: `404` feature off, `401` missing or wrong token, `403` a probe token or a token without the scope, `413` body over 1 MB, `400` bad JSON, bad `If-Match` or id mismatch, `428`, `503` the checks file cannot be written (component writes only), `412` (also when the file on disk differs from the applied one, naming the file state), `422` the body or the resulting file is invalid (the same messages as the checks file; they never quote a value), `409` id exists or still referenced, `404` unknown id or index. `405` for another method. A `401` or `403` is logged as `admin auth failed` and counted in `pulse_api_admin_auth_failures_total` (see [Logs](operation.md#logs)).

Bodies are validated by the same parsers as the file, so unknown keys, limits and `{"env": NAME}` headers behave as in [checks.json](configuration.md#checksjson). Each check view has `source` (`file` or `database`). Responses never contain literal header values, request bodies or heartbeat secrets: each literal header value and the body are shown as `{"keep": true}`, `{"env": NAME}` references are shown as they are, and a heartbeat check shows `hasSecret: true`. On a `PUT`, a `{"keep": true}` marker keeps the stored value of the same database check (header names match case-insensitively); a marker on create, on a value that is not stored, or of another shape answers `422`. A database heartbeat secret is stored only as its SHA-256 digest. Components may reference only file checks (`422` otherwise). A heartbeat `secret` is write-only: send it on `POST` or to rotate it with `PUT`; a `PUT` without `secret` keeps the old one, and changing a check to a heartbeat check needs one.

`GET /probe/checks` and `POST /results` need a probe token. An admin-side token gets `403` there.

Every successful write adds one [audit entry](#audit-log) with the new revision. A check write stores its definition, the generation and the audit entry in one transaction; a failure answers `500` and changes nothing. A window write stores its definition, the generation and the audit entry in one transaction in the same way. A component write follows the file protocol below. The entry is first stored as pending, durably, before the file is renamed, and is confirmed after the rename is on disk. If the pending entry cannot be stored, the file stays unchanged and the answer is `500 {"error":"audit log could not be written"}`. If the file was stored but the confirmation failed, the answer is `500 {"error":"checks file stored; its audit entry is pending and is resolved at the next write or restart"}`. See [Audit durability](operation.md#audit-durability).

### GET /admin/config/export

Needs `read` or `checks`, like `GET /admin/config`; a probe token gets `403`. The answer is `200` with `content-type: application/json; charset=utf-8`, `content-disposition: attachment; filename="checks.json"`, `cache-control: no-store` and the admin revision as `ETag`. The body is `AdminConfigExport`, JSON with two spaces and a final newline: `checks` is the effective set in effective order (a file check wins over the database check with the same id; a shadowed database check is never exported), `components` are those of the applied file; `maintenance` holds the effective windows: the file windows, then one entry per effective check of each unshadowed database window, with times as ISO 8601 UTC strings. Window ids are not exported, so loading the export as a checks file gives id-less file windows; shadowed database windows are not exported. `{"env": NAME}` headers stay. Literal header values, bodies and heartbeat secrets are left out, and a top-level `redacted` list of `{checkId, field}` (`headers.<name>`, `body` or `secret`, in check order) names each one. `redacted` is absent when nothing was left out. Any query parameter answers `400`; another method answers `405` with `Allow: GET`.

An export with `redacted` cannot be loaded as a checks file: the file parser refuses the unknown `redacted` key. Put the listed values back (choose a new secret for each heartbeat check, since the old one is stored only as a digest), then remove `redacted`. There is no import route: the export is for a person to edit and install as the checks file.

## Scopes

Tokens are stored in the database as SHA-256 digests only. Each token has one or more scopes, in the order `read`, `checks`, `incidents`, `admin`, `probe`, `status`, `notify`. A probe token has exactly `["probe"]` and a `location`. A service token has exactly `["status"]` or `["notify"]` and no location. An admin-side token has 1 to 4 of `read`, `checks`, `incidents` and `admin`, and no location.

| Route                                                                            | Passes when the token holds  |
| -------------------------------------------------------------------------------- | ---------------------------- |
| `GET /probe/checks`, `POST /results`                                             | `probe`                      |
| `GET /admin/config`                                                              | `read` or `checks`           |
| `POST`/`PUT`/`DELETE` `/admin/checks`, `/admin/components`, `/admin/maintenance` | `admin` and `checks`         |
| Manual-incident writes                                                           | `admin` and `incidents`      |
| `GET /admin/tokens`, `GET /admin/tokens/self`, `GET /admin/tokens/:id`           | `admin`                      |
| `POST /admin/tokens`, `.../rotate`, `.../revoke`                                 | `admin`, plus the grant rule |
| `GET /admin/audit`, `GET /admin/audit/export`                                    | `admin`                      |
| `GET`/`PUT /admin/status/settings`                                               | `admin`                      |
| `GET /service/status/settings`, `PUT /service/status/report`                     | exactly `["status"]`         |

Statuses on admin routes: `404` before the first admin import, then `401` `{"error":"unauthorized"}` with `WWW-Authenticate: Bearer` for a missing, unknown, expired, revoked or rotated-out token (the body never says which), then `403` `{"error":"forbidden"}` for a probe, `status` or `notify` token, then `401` `{"error":"unauthorized"}` with `WWW-Authenticate: Bearer` for an admin-side secret shorter than 32 characters (the failure log says `token` `short`), then `403` `{"error":"forbidden"}` for a valid token without the scope, then the route's own statuses. The throttle check comes before all auth statuses: a blocked client gets `429` before its token is read.

### Admin maintenance routes

Database maintenance windows. They live in the database, never in the checks file, and work also when the file is broken, unreadable or read-only. A window id is 1 to 64 characters of `a-z`, `0-9`, `.`, `_`, `-` and starts with a letter. The body of `POST` and `PUT` is `AdminMaintenanceWindowInput` `{id, checkIds, start, end, note}`, a strict object: `checkIds` has 1 to 50 distinct ids of checks in effect at write time (file or database), `start` and `end` are integer epoch milliseconds with `0 <= start < end <= 253402300799999` (`9999-12-31T23:59:59.999Z`), and `note` is 1 to 500 characters, one line, without leading or trailing whitespace. At most 1000 database windows are stored.

| Route                           | Permission           | Answer                                                                                                                   |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/maintenance`        | `read` or `checks`   | `200` `AdminMaintenanceList` `{revision, windows, shadowed}`, `ETag`, `cache-control: no-store`; a query parameter `400` |
| `POST /admin/maintenance`       | `admin` and `checks` | `201` `AdminMaintenanceWindow`, `Location: /admin/maintenance/<id>`, new `ETag`                                          |
| `PUT /admin/maintenance/:id`    | `admin` and `checks` | `200` full replace; the body `id` must equal the path id (`400`)                                                         |
| `DELETE /admin/maintenance/:id` | `admin` and `checks` | `204`, new `ETag`                                                                                                        |

Another method answers `405` with `Allow: GET, POST` on the collection and `Allow: PUT, DELETE` on an item. `windows` holds the file windows in file order (`source: "file"`, `index` its position in the file, `id` its file id or `null`, `checkIds: [checkId]`), then the database windows that no file window shadows, in creation order (`source: "database"`, `index: null`). `shadowed` holds the database windows whose id a file window holds. Each entry has `phase`: `planned` (`now < start`), `current` or `past` (`end <= now`). A database entry shows its stored `checkIds`, also ids that are not in effect now.

Statuses of a window write, first match wins: `404` feature off, `401`, `403`, `413` body over 1 MiB (also on `GET` and `DELETE`), `400` bad JSON, bad or `*` `If-Match`, body/path id mismatch, `428` `If-Match` missing, `412` stale revision, `422` schema or reference error (`maintenance.checkIds[1] must reference a configured check`), `409`, `404` unknown id. Window writes never answer `503`. `409` answers a create of an id that the file or the store holds, a create beyond 1000 windows (`too many maintenance windows: delete past ones`), a `PUT` or `DELETE` of a file-only id (`maintenance "<id>" comes from the checks file; edit the file`), a `PUT` of a shadowed id (only `DELETE` is allowed; it leaves the file window in effect) and a decimal path segment that is a file window index (`file maintenance windows are read-only; edit the checks file`). The old file window writes end: the old body `{checkId, start, end, note}` answers `422`, an old `PUT /admin/maintenance/<index>` answers `400`.

Each write adds one audit entry `maintenance.create`, `maintenance.replace` or `maintenance.delete` with target `{kind: "maintenance", id}`; it holds no note. A failure of the store or the audit log answers `500` and changes nothing. Error texts and log lines name ids and field paths, never the note.

### Admin auth throttle

The config, token, audit and status routes under `/admin/*`, the `/service/*` routes, and the manual-incident writes (`POST /manual-incidents`, `/manual-incidents/:id/updates`, `/manual-incidents/:id/resolve`, `DELETE /manual-incidents/:id`) share one budget per client:

- 10 failed authentications (every `401` and `403` above, also `short` and a missing scope) per client in a fixed window of 60 s that starts at the client's first failure. A success does not count and does not reset the window.
- After the 10th failure every request of that client to these routes answers `429` `{"error":"too many requests"}` with `Retry-After: <seconds>` (rounded up, 1 to 60) until the window ends, also with a valid token. The token is not checked, no body is read and nothing is written. Blocked requests do not extend the window. There is no `WWW-Authenticate` header; token and audit routes keep `Cache-Control: no-store`.
- The client is the TCP peer address: an IPv4 address (an IPv4-mapped IPv6 address counts as IPv4), or the `/64` prefix of an IPv6 address. `Forwarded`, `X-Forwarded-For` and other headers are ignored, so clients behind one proxy or NAT share a budget.
- Answers that come before auth are not throttled or counted: `404` before the first admin import, unknown `/admin/*` paths, `405`, a bad manual-incident id. Public reads, ops, probe and heartbeat routes are never throttled.
- Every `429` is counted in `pulse_api_admin_auth_throttled_total{route}`, not in `pulse_api_admin_auth_failures_total`. Limits and overflow: see [Operation](operation.md#admin-auth-throttle).

**Grant rule:** a caller may create, rotate or revoke a token only when it holds every scope of that token, where `probe` counts as `checks` (a probe token reads check headers and bodies), and `status` and `notify` count as `admin` (their tokens read runtime settings). Otherwise `403`.

**Last-admin rule:** revoking the last active token with `admin` answers `409` `{"error":"cannot revoke the last active admin token"}`. A token is active when it is not revoked and not expired. Expiry can still lock everyone out; the recovery is a [backup restore](operation.md#backup-and-restore).

## Tokens

All token routes answer with `cache-control: no-store`, also on `401` and `403`. Bodies are limited to 4096 bytes (`413`). Bad JSON answers `400`. An unknown or malformed `:id` answers `404 {"error":"token not found"}` after auth.

`GET /admin/tokens/self` answers the metadata of the token that made the request, so a client can confirm which token it holds; both secrets of a token in its rotation overlap answer the same `id`. It needs `admin` like the other token routes and keeps their order: `404` while no admin token is imported, then `429`, `401`, `403` (also for a `probe` or `read`-only token), then `405` with `Allow: GET` for another method. Its `lastUsedAt` already counts this request. `self` is matched only as the whole segment: `/admin/tokens/self/rotate` and `/admin/tokens/self/revoke` treat `self` as a malformed id and answer `404`.

| Route                           | Body               | Answer                                                   |
| ------------------------------- | ------------------ | -------------------------------------------------------- |
| `GET /admin/tokens`             | none               | `200` `TokensResponse` `{tokens}`, revoked ones included |
| `GET /admin/tokens/self`        | none               | `200` `TokenMetadata` of the calling token               |
| `GET /admin/tokens/:id`         | none               | `200` `TokenMetadata`                                    |
| `POST /admin/tokens`            | `TokenCreateInput` | `201` `TokenSecretResponse` and a `Location` header      |
| `POST /admin/tokens/:id/rotate` | empty or `{}`      | `200` `TokenSecretResponse`                              |
| `POST /admin/tokens/:id/revoke` | empty or `{}`      | `200` `TokenMetadata`                                    |
- `TokenCreateInput` is `{name, scopes, location?, expiresAt?}`; unknown keys answer `400`, so a client never picks its secret. `name` is 1 to 100 characters after trim without control characters. A probe token needs `location` (1 to 64 characters after trim, stored trimmed); other tokens must not have one. `expiresAt` (epoch ms) must be later than now and at most 3650 days ahead.
- `TokenSecretResponse` is `{token, secret, previousValidUntil}`. The `secret` (`pulse_` and 43 base64url characters) is shown only in this one answer. No other route, log line or audit entry holds it, and it cannot be read again.
- `TokenMetadata` is `{id, name, scopes, location, source, createdAt, lastUsedAt, expiresAt, revokedAt, rotatedAt, previousValidUntil}`. `source` is `api` or `file` (imported). `lastUsedAt` is written to the database at most once a minute per token.
- **Rotation overlap:** a rotate makes a new secret. The old one stays valid for 10 minutes (`previousValidUntil`, at most until `expiresAt`), so a probe or a script can switch without a gap. A second rotate during the overlap answers `409` `{"error":"a rotation is still in its overlap"}`. A revoked token answers `409` `{"error":"token is revoked"}`, an expired one `409` `{"error":"token is expired"}`.
- **Revoke** invalidates every secret of the token at once, also one in its overlap.
- Each write logs `token write` with the caller's name, the action and the token id.

```sh
curl -sS "$API/admin/tokens/self" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "$API/admin/tokens" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"probe eu","scopes":["probe"],"location":"eu"}'
curl -sS -X POST "$API/admin/tokens/<id>/rotate" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "$API/admin/tokens/<id>/revoke" -H "Authorization: Bearer $TOKEN"
```

## Status settings

The console edits the status page settings in the database; the status service reads them and reports what it applied. The settings have their own revision, apart from the checks revision: a status save never makes a check write stale, and a check write never makes a status save stale.

| Route                          | Token                | Answer                                                                                                                                                        |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/status/settings`   | `admin`              | `200` `AdminStatusSettingsView` `{revision, settings, service}`, `ETag`, `cache-control: no-store`; never `304`, because `service` changes without a revision |
| `PUT /admin/status/settings`   | `admin`              | body `StatusSettings`, `If-Match` required; `200` view with the new `ETag`                                                                                    |
| `GET /service/status/settings` | exactly `["status"]` | `200` `ServiceStatusSettings` `{revision, settings}` with `ETag`; `304` on a matching `If-None-Match`                                                         |
| `PUT /service/status/report`   | exactly `["status"]` | body `StatusServiceReport`; `204`                                                                                                                             |
- Other methods answer `405` with `Allow` (`GET, PUT`, `GET`, `PUT`), after auth.
- Statuses, first match wins: `429`, `401`, `403` (also an admin token on `/service/*` and a `status` or `notify` token on `/admin/*`), `413` body over 1 MiB (also on `GET`), `400` bad JSON or a malformed `If-Match`, `428` `If-Match` missing, `412` `the settings changed: reload them and retry`, `422`.
- `422` answers a document that the contract refuses (field rules, more than 65 536 bytes as JSON, a repeated component id) and a `componentOrder` id that is not a current component (`settings.componentOrder[1]: must reference a current component`).
- A `PUT` replaces the whole document: an absent field takes its default. The settings, the new revision and one `status-settings.replace` audit entry commit in one transaction. The entry holds no settings value.
- A report body is limited to 524 288 bytes (`413` beyond; the stored report stays). A valid report replaces the last one, whole; `receivedAt` is the api clock. A report bumps no revision and writes no audit entry. The service part of the admin view is `never` without a report, `fresh` up to 180 000 ms after `receivedAt`, and `stale` after that.
- Service routes use the admin auth throttle and log one `service report` line without values.

```sh
curl -sS "$API/admin/status/settings" -H "Authorization: Bearer $ADMIN_TOKEN" -D - -o /dev/null | grep -i etag
curl -sS -X PUT "$API/admin/status/settings" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -H 'If-Match: "sha256-<hex>"' -d '{"name":"Acme status"}'
curl -sS "$API/service/status/settings" -H "Authorization: Bearer $STATUS_TOKEN"
```

## Audit log

Every admin write is stored as an `AuditEntry` `{id, at, actor: {tokenId, name}, action, target: {kind, id}, revision}`. `actor.name` is the token name at write time. `action` is one of `check.*`, `component.*`, `maintenance.*` (`create`, `replace`, `delete`), `manual-incident.*` (`create`, `update`, `resolve`, `delete`, `edit`, `draft-save`, `draft-discard`, `publish`, `note-add`, `note-delete`) `token.*` (`create`, `rotate`, `revoke`, `import`) and `status-settings.replace` (target `{kind: "status-settings", id: "status"}`, `revision` the new status revision). `target.id` is the check or component id unchanged (any length), the window id (older entries of file window writes hold the window index as text), the incident id as text, or the token id. `revision` is the checks file revision after a config write, else `null`. An entry never holds a body, title, message, header, heartbeat secret, URL, token value or digest. Rejected attempts and automatic work (results, pings, reloads, retention) are not audited. Entries are never deleted.

### GET /admin/audit

Query parameters, all optional: `actor` (token id), `action`, `targetKind`, `targetId` (exact), `since` (epoch ms, inclusive), `until` (exclusive), `limit` (1 to 1000, default 100) and `before` (an entry id, the cursor). An unknown or repeated parameter, a malformed value or `since >= until` answers `400` with a message that names the parameter but not its value.

The answer is `200` `AuditPage` `{entries, nextBefore}`, ordered by `id` descending. `nextBefore` is the id to pass as `before` for the next page, or `null` on the last page. Ids follow commit order, so a walk by `before` never skips or repeats an entry; entries committed during the walk show on a fresh first page. `at` is the time of the request, and a config entry confirmed late keeps its `at`, so `at` is not strictly ordered by `id`: a `since`/`until` window can gain an older entry after it was read.

### GET /admin/audit/export

The same filters without `limit` and `before` (either answers `400`). The answer is `200` with `content-type: application/x-ndjson; charset=utf-8`: one JSON entry per line, by `id` ascending, up to the largest id at the start of the export. It is read in batches of 500, so memory stays small. An empty result is an empty body.

```sh
curl -sS "$API/admin/audit?action=check.create&limit=10" -H "Authorization: Bearer $TOKEN"
curl -sS "$API/admin/audit/export" -H "Authorization: Bearer $TOKEN" > audit.ndjson
```

## GET /healthz

Liveness. Returns `200` with the body `ok` as long as the process answers. It does not access the database and also answers `200` while the API shuts down (it answered `503` then before; use `/readyz` for readiness). Any other method (also `HEAD`) gives `405` with `{"error":"method not allowed"}` and `Allow: GET`.

## GET /readyz

Readiness, no token. Returns `200 ok` when `SELECT 1` works on the database and the API is not shutting down. Otherwise `503` with `shutting down` or `database unavailable`; the body never holds a database error text. Any other method gives the same `405` as on `/healthz`. The Docker `HEALTHCHECK` and the Compose gates use it.

## GET /metrics

Prometheus text format, no authentication. Counters live in memory and reset at restart. Any other method gives the same `405` as on `/healthz`.

| Series                                             | Type      | Labels                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pulse_up`                                         | gauge     | none. Always `1`.                                                                                                                                                                                                                                                                                                                                                                           |
| `pulse_api_check_state`                            | gauge     | `check`, `state`. `1` for the current state of each check, `0` for the others.                                                                                                                                                                                                                                                                                                              |
| `pulse_api_results_ingested_total`                 | counter   | `location`. A repeated post is not counted.                                                                                                                                                                                                                                                                                                                                                 |
| `pulse_api_location_last_result_timestamp_seconds` | gauge     | `location`. `lastResultAt` of `GET /locations` in Unix seconds, read at the scrape.                                                                                                                                                                                                                                                                                                         |
| `pulse_api_result_latency_seconds`                 | histogram | `check`. The latency the probe reported. Buckets 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s.                                                                                                                                                                                                                                                                                                     |
| `pulse_api_slo_budget_remaining_ratio`             | gauge     | `check` or `component`. Error budget left as a ratio (0.5 is 50 %, negative when exceeded). Omitted without a target or without results.                                                                                                                                                                                                                                                    |
| `pulse_api_incidents_opened_total`                 | counter   | none                                                                                                                                                                                                                                                                                                                                                                                        |
| `pulse_api_incidents_resolved_total`               | counter   | none                                                                                                                                                                                                                                                                                                                                                                                        |
| `pulse_api_http_requests_total`                    | counter   | `route` (a pattern such as `/checks/:id/results`, `/checks/:id/latency`, `/checks/:id/location-uptime`, `/heartbeat/:id`, or `unmatched`), `code`. Requests to `/admin/manual-incidents` and below are never counted.                                                                                                                                                                       |
| `pulse_heartbeat_pings_total`                      | counter   | `check`. Accepted pings. Failed pings are only in the request counter, with code 401.                                                                                                                                                                                                                                                                                                       |
| `pulse_heartbeat_missed_total`                     | counter   | `check`. One per `period` elapsed after the deadline `period + grace`.                                                                                                                                                                                                                                                                                                                      |
| `pulse_api_admin_auth_failures_total`              | counter   | `route` (pattern), `status` (`401`, `403`). Failed admin authentications on `/admin/*` and the manual-incident writes. The private manual-incident routes use the patterns `/admin/manual-incidents`, `…/:id`, `…/:id/draft`, `…/:id/publish`, `…/:id/notes` and `…/:id/notes/:noteId`. A series appears at its first failure; alert with `increase(...) > 0` and `or vector(0)` as needed. |
| `pulse_api_admin_auth_throttled_total`             | counter   | `route` (pattern). Admin requests refused with `429` by the auth throttle. A series appears at its first `429`.                                                                                                                                                                                                                                                                             |

The labels hold check ids and locations only. Check URLs, hosts, keywords, reasons and tokens never appear. The check ids are still configuration, so do not publish `/metrics` on a public network: scrape it from the private network, as with the read routes above.
