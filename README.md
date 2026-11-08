# pulse-api

[![CI](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. pulse-api is its backend: it receives probe results, stores them in SQLite, computes up/down state and incidents, and serves them over REST.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared types. [pulse-probe](https://github.com/lorenzh/pulse-probe) reads checks from it and posts results to it, and [pulse-status](https://github.com/lorenzh/pulse-status) reads from it to render the status page.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Checks come from the checks file and from the database: admin check writes are stored in the database, a file check wins over a database check with the same id, and a broken checks file no longer blocks a restart once a file was applied. Components stay in the file. Maintenance windows come from the file and from the database: `POST /admin/maintenance` stores a database window that may name file and database checks, a file window with the same optional `id` wins over it, file windows are read-only through the admin API, and `GET /admin/maintenance` lists the effective and shadowed windows. `GET /admin/config/export` returns the effective checks and the effective windows (without window ids) as one checks file, with env names and without literal header values, bodies or heartbeat secrets; a non-empty `redacted` list names what was left out, and such an export loads as a checks file only after those values are put back and `redacted` is removed. There is no import. See [Changing checks](docs/operation.md#changing-checks).

Contributing: see [AGENTS.md](AGENTS.md) and [docs/development.md](docs/development.md).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.

## Quick start

Requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
cp checks.example.json checks.json   # replace the heartbeat secret of nightly-backup, or remove that check
cp tokens.example.json tokens.json   # replace the placeholder tokens
bun start
```

The database is created with the current schema. A file from an older version is upgraded in place at start; see [Operation](docs/operation.md#schema). A file from a newer version is refused.

### Docker Compose

The Compose setups of the whole stack live in [pulse-deploy](https://github.com/lorenzh/pulse-deploy). Its [`full`](https://github.com/lorenzh/pulse-deploy/blob/main/full/README.md) setup runs api, probe, status, notify and console; its [`demo`](https://github.com/lorenzh/pulse-deploy/blob/main/demo/README.md) setup shows every status page state.

### Image

Each release publishes a multi-arch image (linux/amd64, linux/arm64) with build provenance to `ghcr.io/lorenzh/pulse-api`:

```sh
docker pull ghcr.io/lorenzh/pulse-api:0.1.0
```

The image runs `bun --no-env-file`: it never reads `.env` files, also not mounted ones. Pass settings with `-e`, `--env-file` or Compose `environment:`.

See [Releasing](docs/development.md#releasing) for the tags and how to verify an image.

## Heartbeat checks

A check of type `heartbeat` is for cron jobs and workers. The job calls `POST|GET /heartbeat/<id>` with `Authorization: Bearer <secret>`; no ping within `period + grace` opens an incident, and the next ping resolves it. See [Configuration](docs/configuration.md#heartbeat-checks), [REST API](docs/rest-api.md#getpost-heartbeatidsecret) and [Operation](docs/operation.md#heartbeat-checks).

## Per-location uptime

`GET /checks/:id/location-uptime` is a public read. It answers `CheckLocationUptime`: per location, the results and the good (not `down`) results of the 90-day uptime window, and their uptime. Only `GET` is served; `HEAD` and the other methods answer `405` with `Allow: GET`. The check ids `.` and `..` cannot be addressed by per-id routes. See [REST API](docs/rest-api.md#get-checksidlocation-uptime).

## Manual incidents

Checks, components and maintenance windows can be changed through `/admin/*` routes with a token that has the scopes `admin` and `checks`, and the API applies a changed checks file without a restart: it looks at the file every `PULSE_CHECKS_RELOAD_INTERVAL_MS` (default 5000, `0` is off) and on `SIGHUP`. See [REST API](docs/rest-api.md#admin-config-routes) and [Operation](docs/operation.md#changing-checks).

Operators post incidents with timed updates through `POST /manual-incidents`, `/manual-incidents/:id/updates` and `/manual-incidents/:id/resolve`, and read them from `GET /manual-incidents`. Writes need a token with `admin` and `incidents`. Before the first admin import from `PULSE_API_ADMIN_TOKENS_FILE` (copy `admin-tokens.example.json`) the feature is off: writes answer `404` and the reads are empty. Drafts, internal notes and internal-only incidents are managed under `/admin/manual-incidents` with the same token: a draft is published with `POST /admin/manual-incidents/:id/publish`, and only published `public` incidents ever reach the public reads, the metrics counters or notify. See [REST API](docs/rest-api.md#manual-incidents) for the shapes, limits and `curl` examples.

## Tokens and audit

Probe and admin tokens are stored in the database as SHA-256 digests, with scopes (`read`, `checks`, `incidents`, `admin`, `probe`, `status`, `notify`), an optional expiry and a last-used time. `tokens.json` and the admin tokens file are imported once at the first start and then ignored. Admin-side secrets need at least 32 characters, probe tokens at least 16; a shorter stored admin-side secret answers `401`. Admin auth is throttled: after 10 failed admin authentications (any `401` or `403`) from one client within 60 s of its first failure, every admin request of that client answers `429` `{"error":"too many requests"}` with `Retry-After` (seconds, 1 to 60) until that window ends, also with a valid token. The budget is shared across `/admin/*` and the manual-incident writes and counted in `pulse_api_admin_auth_throttled_total{route}`. Admins create, list, rotate (10-minute overlap) and revoke tokens through `/admin/tokens`; `GET /admin/tokens/self` answers the metadata of the calling admin token. Every admin write is stored as a secret-free audit entry, served by `GET /admin/audit` and `GET /admin/audit/export` (JSON lines). See [REST API](docs/rest-api.md#tokens), [Configuration](docs/configuration.md#token-import) and [Operation](docs/operation.md#token-rotation).

## Status settings

The console reads and saves the status page settings with `GET`/`PUT /admin/status/settings` (`admin`, `If-Match` required on `PUT`). The status service reads them with `GET /service/status/settings` and reports what it applied with `PUT /service/status/report`, with a token whose only scope is `status`. The settings have their own revision, so status saves and check writes never make each other stale. Create the `status` token after the console and this api are rolled out. See [REST API](docs/rest-api.md#status-settings).

## Notify channels

The console creates, replaces and deletes database notify channels through `/admin/notify/channels[/:id]` (`admin`, `If-Match` required) and reads failed deliveries with `GET /admin/notify/failed`. Notify reads the channels with `GET /service/notify/channels` and reports with `PUT /service/notify/report`, with a token whose only scope is `notify`. A channel holds secret reference names only, never values. At most 100 channels, 16 384 bytes per definition and 262 144 bytes in total. A file channel of notify with the same id shadows a database channel. The console resends a failed delivery with `POST /admin/notify/resends`; notify claims commands with `POST /service/notify/resends/claim` and posts outcomes to `/service/notify/resends/:id/result`. A repeated `requestId` gets the same command again. See [REST API](docs/rest-api.md#notify-channels) and [Resend](docs/rest-api.md#resend).

The performance bench measures this traffic: `bun bench/run.ts --others-ref main --simulate-services` sends the status and notify requests from the harness, and `--service-tokens` gives the real services their tokens. See [bench/README.md](bench/README.md#runtime-configuration-traffic). A failed bench command keeps its full stderr for diagnosis and shows only the tail; see [Reading a failure](bench/README.md#reading-a-failure). Several bench runs can start in parallel on one machine: each takes its host ports from outside the ephemeral range, and a port bind failure gets one retry with new ports; see [Host ports](bench/README.md#host-ports).

## Health and metrics

`GET /locations` (no token) lists the probe locations as `reporting` or `silent`; `PULSE_LOCATION_SILENT_MS` sets the threshold (default derived from the check intervals) and the metric `pulse_api_location_last_result_timestamp_seconds{location}` mirrors it. `POST /results` is idempotent on (check, location, timestamp), so a probe may re-send. A re-send stores no second row, and a results page keeps the whole group of one timestamp, so it can exceed `limit` across locations: see [GET /checks/:id/results](docs/rest-api.md#get-checksidresults). See [REST API](docs/rest-api.md#get-locations).

`GET /healthz` is liveness: it answers `200 ok` without touching the database, also while the API shuts down. `GET /readyz` is readiness: `200 ok` when the database answers and the API is not shutting down, else `503` without error text. A request target that is not a valid URL path answers `400 {"error":"invalid request target"}` without logging and without repeating the target. Admin requests refused by the auth throttle answer `429` and count in `pulse_api_admin_auth_throttled_total`. `GET /metrics` serves Prometheus text with check ids only: keep it on a private network. Logs are JSON lines (`PULSE_LOG_LEVEL`). An unexpected request failure is logged once as `request failed`: before the response headers it answers `500 {"error":"internal error"}`, after them the started response is closed without a second answer. The API stops cleanly on `SIGINT` and `SIGTERM` (exit 0). A shutdown that hits its 5 s bound closes the remaining connections, finishes cleanup, closes the database and exits 1. A configuration error prints one line `pulse-api: <message>` and exits with 2. See [Operation](docs/operation.md).

## Documentation

Start at [docs/index.md](docs/index.md):

- [Install](docs/install.md), [Configuration](docs/configuration.md) and [Concepts](docs/concepts.md)
- [REST API](docs/rest-api.md)
- [Operation](docs/operation.md) and [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)

Licensed under the MIT licence, see [LICENSE](LICENSE).
