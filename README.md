# pulse-api

[![CI](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. pulse-api is its backend: it receives probe results, stores them in SQLite, computes up/down state and incidents, and serves them over REST.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared types. [pulse-probe](https://github.com/lorenzh/pulse-probe) reads checks from it and posts results to it, and [pulse-status](https://github.com/lorenzh/pulse-status) reads from it to render the status page.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Install, test, run

Requires Node >= 24.

```sh
npm ci
npm run check   # lint, typecheck and tests
cp checks.example.json checks.json
npm start
```

`node:sqlite` prints an experimental warning on start; this is expected.

## Formatting and linting

Biome formats and lints the code (`biome.json`). `npm run lint` checks without changing files; `npm run format` applies fixes. `npm ci` installs a Lefthook pre-commit hook (`lefthook.yml`) that runs Biome on staged files and rejects the commit if they are badly formatted or fail lint.

## Settings

| Env                 | Default         | Meaning           |
| ------------------- | --------------- | ----------------- |
| `PORT`              | `3000`          | HTTP port         |
| `PULSE_DB`          | `./pulse.db`    | SQLite file       |
| `PULSE_CHECKS_FILE` | `./checks.json` | Checks definition |

## Checks file

`checks.json` is `{"checks": [...]}`. Each check has:

| Field        | Required | Meaning                                                                            |
| ------------ | -------- | ---------------------------------------------------------------------------------- |
| `id`         | yes      | Non-empty string, unique in the file                                               |
| `name`       | yes      | Non-empty string                                                                   |
| `url`        | yes      | `http` or `https` URL to probe                                                     |
| `intervalMs` | yes      | Positive integer, milliseconds between probes                                      |
| `timeoutMs`  | no       | Positive integer, milliseconds; when omitted the probe uses its own default (5000) |

`url` is required for HTTP checks (`type` absent or `"http"`). HTTP checks also take:

| Field                | Required | Meaning                                                                                                                                                                                                           |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retries`            | no       | Integer 0–10, default 0: extra attempts the probe makes after a failed one before reporting down                                                                                                                  |
| `retryDelayMs`       | no       | Integer 0–60000, default 1000: wait between attempts                                                                                                                                                              |
| `latencyObjectiveMs` | no       | Positive integer, milliseconds: a successful (2xx) result slower than this is `degraded`; absent means no objective. An objective at or above `timeoutMs` can never be degraded. Served by `GET /checks` when set |

`GET /checks` always serves the resolved `retries` and `retryDelayMs` for HTTP checks. When `retries` is above 0, the file is rejected unless the worst case `(retries + 1) * timeoutMs + retries * retryDelayMs` (`timeoutMs` defaulting to 5000) fits within `intervalMs`. Results carry `attempts` (integer ≥ 1, the attempts made); a missing value on `POST /results` is stored as 1, and results stored before retries existed read as 1. State and incident computation are unchanged. Existing database files are migrated at startup.

A TLS check (`"type": "tls"`) watches the expiry of a server's leaf certificate. It takes no `url`:

| Field      | Required | Meaning                                                                  |
| ---------- | -------- | ------------------------------------------------------------------------ |
| `type`     | yes      | `"tls"`; any other value than `http` or `tls` is rejected                |
| `host`     | yes      | Host name or IP without scheme, port or path                             |
| `port`     | no       | Integer 1–65535, default 443                                             |
| `warnDays` | no       | Positive integer, default 14; down when this many days or fewer are left |

`intervalMs` is required and `timeoutMs` optional as above. Only the leaf certificate's expiry is judged; the chain and host name are not verified. Results carry `certDaysLeft` (stored in `results.cert_days_left`, null for old rows); `GET /checks` shows the latest one and `GET /checks/:id/results` includes it.

See `checks.example.json`. The file is validated and upserted into the database at startup; existing state and results are kept. An invalid or unreadable file stops startup with an error.

### Maintenance windows

The file may also have a top-level `maintenance` array (optional; a missing key means no windows):

| Field     | Required | Meaning                                                              |
| --------- | -------- | -------------------------------------------------------------------- |
| `checkId` | yes      | Id of a configured check                                             |
| `start`   | yes      | ISO 8601 string with an explicit offset (`Z` or `±hh:mm`), inclusive |
| `end`     | yes      | Same format, exclusive, must be after `start`                        |
| `note`    | yes      | Non-empty string shown with the maintenance state                    |

Windows are read at startup only; restart the API to change them. Invalid windows stop startup with a `ConfigError`. Overlapping windows of one check are a union; the one with the earliest `start` is reported.

## State rules

Every result carries a `location` (the probe's name). A missing or empty `location` is stored as `default`; a non-string value or one longer than 64 characters (after trimming) gives 400. Names are trimmed, case-sensitive exact strings. Results stored before locations existed count as `default`; existing database files are migrated at startup.

Each accepted result triggers one evaluation. The window is `[T - 2 * intervalMs, T]` for the result's timestamp `T`; results newer than `T` are ignored. Each location counts by its latest result in the window. With one location in the window it decides alone; with two or more, the combined status is `down` only if at least two locations are down, otherwise `degraded` if any location is degraded, else `up`. The combined status feeds the counter: a check with no results is `unknown`, the third consecutive down evaluation opens an incident (if none is open), and an `up` or `degraded` evaluation resets the counter and resolves it. `openedAt`/`resolvedAt` are the timestamps of the triggering results; the incident `reason` is the reason of the latest down result in the window. Incidents can therefore open sooner than 3 intervals. `lastReason` is the reason of the latest ingested result. The counter is stored and survives restarts.

`GET /checks` adds `locations`: every location ever seen for the check, sorted by name, as `{ location, result, stale }` with the location's latest result; `stale` is true when that result is older than 2 intervals before the check's newest result. A check without results has `locations: []`.

## Maintenance semantics

A result is classified by its own `timestamp`. A down result inside a window is stored (and updates `lastResultAt`/`lastReason`) but leaves the stored state, `consecutiveDown` and incidents untouched. An up result is processed normally, so it resolves an open incident. An incident open when a window starts stays open. While `now` is inside a window, `GET /checks` shows `state: "maintenance"` plus the active `maintenance` window, whatever the stored state; afterwards the stored state shows again. `maintenance` is never stored.

## Routes

- `POST /results` — body `Result`; 204 on success, 400 invalid body, 404 unknown `checkId`.
- `GET /checks` — checks with state.
- `GET /uptime` — `CheckUptime[]`, one entry per check in `GET /checks` order: 90 UTC calendar days (oldest first, the last is today per the service clock) with `date`, `uptime` (percent, unrounded; `degraded` counts as up, all locations count, maintenance is not subtracted; `null` without results) and `results`, plus the result-weighted 90-day `uptime` (`null` without results). Results before the window or after now are ignored. Computed with one aggregate query per check.
- `GET /checks/:id/results?limit=N` — results newest first; `limit` defaults to 100 and is capped at 1000; 400 if `limit` is not a positive integer; 404 unknown check.
- `GET /incidents?status=open|resolved` — both when omitted, open ones first, then newest first; 400 on a bad status.

- `GET /maintenance?checkId=` — windows (`MaintenanceWindow[]`, epoch ms, `[start, end)`) with `end > now`, sorted by `start` then `checkId`; `checkId` is an optional filter. A window is current when `start <= now`, upcoming otherwise.

Other methods on these paths return 405, unknown paths 404, and request bodies over 1,000,000 bytes 413. Errors are `{"error": "..."}`. Types come from `@lorenzh/pulse-contract` (Git dependency pinned to a commit).
