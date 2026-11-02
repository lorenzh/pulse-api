# pulse-api

[![CI](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. pulse-api is its backend: it receives probe results, stores them in SQLite, computes up/down state and incidents, and serves them over REST.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared types. [pulse-probe](https://github.com/lorenzh/pulse-probe) reads checks from it and posts results to it, and [pulse-status](https://github.com/lorenzh/pulse-status) reads from it to render the status page.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

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

## Manual incidents

Checks, components and maintenance windows can be changed through `/admin/*` routes with a token that has the scopes `admin` and `checks`, and the API applies a changed checks file without a restart: it looks at the file every `PULSE_CHECKS_RELOAD_INTERVAL_MS` (default 5000, `0` is off) and on `SIGHUP`. See [REST API](docs/rest-api.md#admin-config-routes) and [Operation](docs/operation.md#changing-checks).

Operators post incidents with timed updates through `POST /manual-incidents`, `/manual-incidents/:id/updates` and `/manual-incidents/:id/resolve`, and read them from `GET /manual-incidents`. Writes need a token with `admin` and `incidents`. Before the first admin import from `PULSE_API_ADMIN_TOKENS_FILE` (copy `admin-tokens.example.json`) the feature is off: writes answer `404` and the reads are empty. See [REST API](docs/rest-api.md#manual-incidents) for the shapes, limits and `curl` examples.

## Tokens and audit

Probe and admin tokens are stored in the database as SHA-256 digests, with scopes (`read`, `checks`, `incidents`, `admin`, `probe`), an optional expiry and a last-used time. `tokens.json` and the admin tokens file are imported once at the first start and then ignored. Admins create, list, rotate (10-minute overlap) and revoke tokens through `/admin/tokens`. Every admin write is stored as a secret-free audit entry, served by `GET /admin/audit` and `GET /admin/audit/export` (JSON lines). See [REST API](docs/rest-api.md#tokens), [Configuration](docs/configuration.md#token-import) and [Operation](docs/operation.md#token-rotation).

## Health and metrics

`GET /locations` (no token) lists the probe locations as `reporting` or `silent`; `PULSE_LOCATION_SILENT_MS` sets the threshold (default derived from the check intervals) and the metric `pulse_api_location_last_result_timestamp_seconds{location}` mirrors it. `POST /results` is idempotent on (check, location, timestamp), so a probe may re-send. See [REST API](docs/rest-api.md#get-locations).

`GET /healthz` is liveness: it answers `200 ok` without touching the database, also while the API shuts down. `GET /readyz` is readiness: `200 ok` when the database answers and the API is not shutting down, else `503` without error text. `GET /metrics` serves Prometheus text with check ids only: keep it on a private network. Logs are JSON lines (`PULSE_LOG_LEVEL`). The API stops cleanly on `SIGINT` and `SIGTERM` (exit 0). A shutdown that hits its 5 s bound closes the remaining connections, finishes cleanup, closes the database and exits 1. A configuration error prints one line `pulse-api: <message>` and exits with 2. See [Operation](docs/operation.md).

## Documentation

Start at [docs/index.md](docs/index.md):

- [Install](docs/install.md), [Configuration](docs/configuration.md) and [Concepts](docs/concepts.md)
- [REST API](docs/rest-api.md)
- [Operation](docs/operation.md) and [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)

Licensed under the MIT licence, see [LICENSE](LICENSE).
