# REST API

The API serves JSON over HTTP. The types come from [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md).

## Overview

| Method | Path                  | Auth         | Response                                      |
| ------ | --------------------- | ------------ | --------------------------------------------- |
| `POST` | `/results`            | Bearer token | `204`, no body                                |
| `GET`  | `/checks`             | none         | `ChecksResponse` (`CheckWithState[]`)         |
| `GET`  | `/checks/:id/results` | none         | `ResultsResponse` (`Result[]`)                |
| `GET`  | `/uptime`             | none         | `UptimeResponse` (`CheckUptime[]`)            |
| `GET`  | `/incidents`          | none         | `IncidentsResponse` (`Incident[]`)            |
| `GET`  | `/maintenance`        | none         | `MaintenanceResponse` (`MaintenanceWindow[]`) |

General rules:

- Errors have the body `{"error": "<message>"}` (`ErrorResponse`).
- An unknown path gives `404` with `not found`. Another method on a known path gives `405` with `method not allowed`.
- A request body over 1,000,000 bytes gives `413` with `request body too large`.
- An unexpected failure gives `500` with `internal error`. The cause is written to stderr.
- Timestamps are epoch milliseconds.
- Read routes have no authentication. Run the API on a private network or behind a proxy if the data is not public.

## POST /results

A probe posts one result. The body is a `Result` (`PostResultRequest`).

Headers: `Authorization: Bearer <token>` (the word `Bearer` is case-insensitive, then one space and a non-empty token).

| Field          | Type                           | Rule                                                                        |
| -------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `checkId`      | string                         | Non-empty. Must be a configured check.                                      |
| `timestamp`    | number                         | Finite, epoch ms, set by the probe.                                         |
| `status`       | `"up"`, `"degraded"`, `"down"` | Required.                                                                   |
| `statusCode`   | integer or `null`              | Required. `null` when no response arrived.                                  |
| `latencyMs`    | number                         | Finite and not negative.                                                    |
| `reason`       | string or `null`               | Required.                                                                   |
| `location`     | string                         | Optional. Trimmed, at most 64 characters. Blank means the token's location. |
| `attempts`     | integer                        | Optional, at least 1. A missing value is stored as 1.                       |
| `certDaysLeft` | integer or `null`              | Optional. For TLS checks.                                                   |

The checks run in this order:

1. `405` if the method is not `POST`.
2. `401` `{"error":"unauthorized"}` with header `WWW-Authenticate: Bearer` for a missing, malformed or unknown token.
3. `413` if the body is too large.
4. `400` `body is not valid JSON`.
5. `400` with the first failing field message, for example `status must be "up", "degraded" or "down"`. The messages are listed in [Troubleshooting](troubleshooting.md#400-on-post-results).
6. `403` `location does not match token` if the body has a `location` that differs from the token's location (after trim).
7. `404` `unknown check "<id>"`.
8. `204` and the result is stored. The stored location is always the token's.

Nothing is stored when a request is rejected. The result triggers one evaluation (see [Quorum and incidents](concepts.md#quorum-and-incidents)).

Example (the API runs with the example `tokens.json` entry `east`, and `checks.json` has a check `example`):

```sh
curl -i -X POST http://localhost:3000/results \
  -H 'Authorization: Bearer example-token-0123456789abcdef' \
  -H 'Content-Type: application/json' \
  -d '{"checkId":"example","timestamp":1793265326000,"status":"down","statusCode":503,"latencyMs":12,"reason":"HTTP 503"}'
```

The response is `HTTP/1.1 204 No Content`.

## GET /checks

Returns every check in database rowid order (the order in which the checks were first inserted, not the order of the checks file) with its state (`CheckWithState[]`): the check fields plus `state`, `consecutiveDown`, `lastResultAt`, `lastReason`, `locations`, and when set `maintenance` and `certDaysLeft`. `retries` and `retryDelayMs` are always present for HTTP checks. `timeoutMs`, `latencyObjectiveMs` and `keyword` are present when configured. `locations` has one `{ location, result, stale }` per location ever seen, sorted by name, and is empty for a check without results.

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

## GET /checks/:id/results

Returns the results of one check, newest first (`Result[]`).

| Query   | Meaning                                        |
| ------- | ---------------------------------------------- |
| `limit` | Positive integer. Default 100, capped at 1000. |

Errors: `400` `limit must be a positive integer`, `400` `bad check id` (malformed percent escape), `404` `unknown check "<id>"`.

```sh
curl 'http://localhost:3000/checks/example/results?limit=1'
```

## GET /uptime

Returns one `CheckUptime` per check, in the order of `GET /checks`. Each has `checkId`, `days` and `uptime`. `days` has exactly 90 UTC calendar days, oldest first, and the last is today. A day has `date` (`YYYY-MM-DD`), `uptime` (percent, unrounded, `null` without results) and `results`. `uptime` is the result-weighted value over the window (`null` without results). Results before the window or after now are ignored. See [Uptime](concepts.md#uptime).

```sh
curl http://localhost:3000/uptime
```

## GET /incidents

Returns incidents (`Incident[]`) with `id`, `checkId`, `openedAt`, `resolvedAt` (`null` while open) and `reason`. Open incidents come first, then the newest first.

| Query    | Meaning                                                |
| -------- | ------------------------------------------------------ |
| `status` | `open` or `resolved`. When omitted, both are returned. |

Error: `400` `status must be "open" or "resolved"`.

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

| Query     | Meaning                       |
| --------- | ----------------------------- |
| `checkId` | Optional filter on one check. |

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
