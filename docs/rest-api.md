# REST API

The API serves JSON over HTTP. The types come from [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md).

## Overview

| Method        | Path                       | Auth             | Response                                               |
| ------------- | -------------------------- | ---------------- | ------------------------------------------------------ |
| `POST`        | `/results`                 | Bearer token     | `204`, no body                                         |
| `GET`         | `/probe/checks`            | Bearer token     | `Check[]` (active checks as configured)                |
| `GET`         | `/checks`                  | none             | `ChecksResponse` (`CheckWithState[]`)                  |
| `GET`         | `/checks/:id/results`      | none             | `ResultsResponse` (`Result[]`)                         |
| `GET`         | `/uptime`                  | none             | `UptimeResponse` (`CheckUptime[]`)                     |
| `GET`         | `/components`              | none             | `ComponentsResponse` (`ComponentWithState[]`)          |
| `GET`         | `/components/uptime`       | none             | `ComponentsUptimeResponse` (`ComponentUptime[]`)       |
| `GET`         | `/incidents`               | none             | `IncidentsResponse` (`Incident[]`)                     |
| `GET`         | `/maintenance`             | none             | `MaintenanceResponse` (`MaintenanceWindow[]`)          |
| `GET`, `POST` | `/heartbeat/:id[/:secret]` | Heartbeat secret | `204`, no body; `401` for a wrong secret or unknown id |
| `GET`         | `/healthz`                 | none             | `200 ok` (liveness, `text/plain`)                      |
| `GET`         | `/readyz`                  | none             | `200 ok` or `503` with a reason (`text/plain`)         |
| `GET`         | `/metrics`                 | none             | Prometheus text                                        |

General rules:

- Errors have the body `{"error": "<message>"}` (`ErrorResponse`).
- An unknown path gives `404` with `not found`. Another method on a known path gives `405` with `method not allowed` and, on `/healthz`, `/readyz` and `/metrics`, the header `Allow: GET`.
- A request body over 1,000,000 bytes gives `413` with `request body too large`.
- An unexpected failure gives `500` with `internal error`. The cause is written to stderr.
- Timestamps are epoch milliseconds.
- Read routes have no authentication. Run the API on a private network or behind a proxy if the data is not public.

## POST /results

A probe posts one result. The body is a `Result` (`PostResultRequest`).

Headers: `Authorization: Bearer <token>` (the word `Bearer` is case-insensitive, then one space and a non-empty token).

| Field          | Type                           | Rule                                                                                                                                                                                              |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkId`      | string                         | Non-empty. Must be a configured check.                                                                                                                                                            |
| `timestamp`    | integer                        | Epoch ms, set by the probe. At most `min(intervalMs of the check, 60000)` ms after the API clock (60000 for heartbeat checks and unknown ids) and at most 7 days (`MAX_RESULT_AGE_MS`) before it. |
| `status`       | `"up"`, `"degraded"`, `"down"` | Required.                                                                                                                                                                                         |
| `statusCode`   | integer or `null`              | Required. `null` when no response arrived, else 100 to 599.                                                                                                                                       |
| `latencyMs`    | number                         | Finite, from 0 to 86400000 (`MAX_LATENCY_MS`).                                                                                                                                                    |
| `reason`       | string or `null`               | Required. At most 1000 UTF-16 code units (`MAX_REASON_LENGTH`).                                                                                                                                   |
| `location`     | string                         | Optional. Trimmed, at most 64 characters. Blank means the token's location.                                                                                                                       |
| `attempts`     | integer                        | Optional, 1 to 100 (`MAX_ATTEMPTS`). A missing value is stored as 1.                                                                                                                              |
| `certDaysLeft` | integer or `null`              | Optional. For TLS checks (certificate) and domain checks (registration expiry, negative when expired).                                                                                            |

The checks run in this order:

1. `405` if the method is not `POST`.
2. `401` `{"error":"unauthorized"}` with header `WWW-Authenticate: Bearer` for a missing, malformed or unknown token.
3. `413` if the body is too large.
4. `400` `body is not valid JSON`.
5. `400` with the first failing field message. The body is first checked by the contract validator `validatePostResultRequest`, whose messages name the path, for example `result.status: must be one of "up", "degraded", "down"`. Then the api checks run: timestamp window, `latencyMs`, `reason` length, `attempts` and `location`. The messages are listed in [Troubleshooting](troubleshooting.md#400-on-post-results).
6. `403` `location does not match token` if the body has a `location` that differs from the token's location (after trim).
7. `404` `unknown check "<id>"` (also for a check removed from the checks file).
8. `204` and the result is stored. The stored location is always the token's.

Every message names the field, for example `timestamp is more than 60000 ms in the future` or `timestamp is older than 7 days`. Nothing is stored when a request is rejected.

A result older than the newest stored result of the same check (any location) never changes the state, the counter, the incidents or `lastResultAt`; it is stored and listed in the results history (see [Late results](concepts.md#late-results)). Rows stored earlier with a future timestamp are not cleaned up; an operator can delete them from the `results` table.

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

Returns every active check (checks removed from the checks file are left out) in database rowid order (the order in which the checks were first inserted, not the order of the checks file) with its state (`CheckWithState[]`): the check fields plus `state`, `consecutiveDown`, `lastResultAt`, `lastReason`, `locations`, and when set `maintenance` and `certDaysLeft`. `retries` and `retryDelayMs` are always present for HTTP checks. `timeoutMs`, `latencyObjectiveMs` and `keyword` are present when configured. `method` and `expectedStatus` are present only when they are not the defaults (`GET`, `200-299`). `headers`, `body` and `jsonAssert` are never served here: see [GET /probe/checks](#get-probechecks). `locations` has one `{ location, result, stale }` per location ever seen, sorted by name, and is empty for a check without results.

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

Needs the probe `Authorization: Bearer <token>` header, like `POST /results`. Answers `401` without a valid token and `405` for other methods. Returns every active check as written in the checks file (`Check[]`), without state, including `method`, `headers`, `body`, `expectedStatus` and `jsonAssert`. A header value `{"env": "NAME"}` is served as it is: the probe resolves it. Literal header values and bodies are served in clear text, so keep the probe tokens secret.

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

## GET /uptime

Returns one `CheckUptime` per active check, in the order of `GET /checks`. Each has `checkId`, `days` and `uptime`. `days` has exactly 90 UTC calendar days, oldest first, and the last is today. A day has `date` (`YYYY-MM-DD`), `uptime` (percent, unrounded, `null` without results) and `results`. `uptime` is the result-weighted value over the window (`null` without results). Results before the window or after now are ignored. See [Uptime](concepts.md#uptime).

```sh
curl http://localhost:3000/uptime
```

## GET /components

Returns one `ComponentWithState` per component of the checks file, in configured order, or `[]` without components. It carries the configured fields (`id`, `name`, `description`, `group`, `checkIds`) plus:

- `state`: the combined state of the member checks, including `maintenance`. First match wins: any `down` gives `down`; any `degraded` gives `degraded`; else, after dropping `maintenance` and `unknown`, any `up` gives `up`; else any `maintenance` gives `maintenance`; else `unknown`.
- `uptime`: the 90-day window value of `GET /components/uptime`, `null` when no member has results.
- `incidentIds`: ids of the open incidents of the member checks, ascending.

## GET /components/uptime

Returns one `ComponentUptime` (`componentId`, `days`, `uptime`) per component, in configured order. `days` has 90 UTC days, oldest first. A day's uptime is result-weighted over the member checks: `sum(up + degraded) / sum(results) * 100`, `null` with `results: 0` when no member has results that day. A check in several components counts in each. `GET /uptime` is unchanged.

## Read cache

`GET /checks` and `GET /uptime` answers are reused for up to 5 s. Every ingest (`POST /results`, a heartbeat ping or expiry), a checks file load and every retention delete clears the cache, so a result is visible right after it is accepted. The TTL only bounds changes made by the clock; a maintenance window that opens or closes also ends a cached answer.

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

Public, like the other reads. `?status=open|resolved|all` (default `all`): open incidents (newest created first), then incidents resolved within 14 days (newest first, at most 50). `resolved` returns only the second group. Another value answers `400`. `GET /manual-incidents/:id` answers one incident or `404`. Without `PULSE_API_ADMIN_TOKENS_FILE` the feature is off: the list is empty and every id answers `404`, even when the database holds incidents.

### Write routes

All need `Authorization: Bearer <admin token>` (see [admin-tokens.json](configuration.md#admin-tokensjson)). A missing, wrong or probe token answers `401`. Without `PULSE_API_ADMIN_TOKENS_FILE` they answer `404`.

| Route                                | Body                                                                                                      | Answer                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------- |
| `POST /manual-incidents`             | `title`, `impact`, `componentIds`, `message`, optional `status` (default `investigating`, not `resolved`) | `201` and the incident |
| `POST /manual-incidents/:id/updates` | `status` (may be `resolved`), `message`                                                                   | `201` and the incident |
| `POST /manual-incidents/:id/resolve` | optional `message` (default `Resolved.`)                                                                  | `200` and the incident |
| `DELETE /manual-incidents/:id`       | none                                                                                                      | `204`                  |

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

`GET /components` is unchanged: it does not apply manual incidents. The status page maps an open incident's impact to the state of its components (`minor` to `degraded`, `major` and `critical` to `down`) with `incidentImpactState` of the contract.

## GET /healthz

Liveness. Returns `200` with the body `ok` as long as the process answers. It does not access the database and also answers `200` while the API shuts down (it answered `503` then before; use `/readyz` for readiness). Any other method (also `HEAD`) gives `405` with `{"error":"method not allowed"}` and `Allow: GET`.

## GET /readyz

Readiness, no token. Returns `200 ok` when `SELECT 1` works on the database and the API is not shutting down. Otherwise `503` with `shutting down` or `database unavailable`; the body never holds a database error text. Any other method gives the same `405` as on `/healthz`. The Docker `HEALTHCHECK` and the Compose gates use it.

## GET /metrics

Prometheus text format, no authentication. Counters live in memory and reset at restart. Any other method gives the same `405` as on `/healthz`.

| Series                               | Type      | Labels                                                                                      |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------- |
| `pulse_up`                           | gauge     | none. Always `1`.                                                                           |
| `pulse_api_check_state`              | gauge     | `check`, `state`. `1` for the current state of each check, `0` for the others.              |
| `pulse_api_results_ingested_total`   | counter   | `location`                                                                                  |
| `pulse_api_result_latency_seconds`   | histogram | `check`. The latency the probe reported. Buckets 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s.     |
| `pulse_api_incidents_opened_total`   | counter   | none                                                                                        |
| `pulse_api_incidents_resolved_total` | counter   | none                                                                                        |
| `pulse_api_http_requests_total`      | counter   | `route` (a pattern such as `/checks/:id/results`, `/heartbeat/:id`, or `unmatched`), `code` |
| `pulse_heartbeat_pings_total`        | counter   | `check`. Accepted pings. Failed pings are only in the request counter, with code 401.       |
| `pulse_heartbeat_missed_total`       | counter   | `check`. One per `period` elapsed after the deadline `period + grace`.                      |

The labels hold check ids and locations only. Check URLs, hosts, keywords, reasons and tokens never appear. The check ids are still configuration, so do not publish `/metrics` on a public network: scrape it from the private network, as with the read routes above.
