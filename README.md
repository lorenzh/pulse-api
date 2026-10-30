# pulse-api

[![CI](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. pulse-api is its backend: it receives probe results, stores them in SQLite, computes up/down state and incidents, and serves them over REST.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared types. [pulse-probe](https://github.com/lorenzh/pulse-probe) reads checks from it and posts results to it, and [pulse-status](https://github.com/lorenzh/pulse-status) reads from it to render the status page.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md) and [docs/development.md](docs/development.md).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.

## Quick start

Requires Node >= 24.

```sh
npm ci
cp checks.example.json checks.json
cp tokens.example.json tokens.json   # replace the placeholder tokens
npm start
```

`node:sqlite` prints an experimental warning on start; this is expected.

### Docker Compose

`compose.yaml` runs the whole stack: api, one probe, status and notify. It needs Docker Compose >= 2.23 and access to github.com.

```sh
cp .env.example .env
# Put a random token into .env. The placeholder in .env.example is rejected at start.
sed -i.bak "s/^PULSE_PROBE_TOKEN=.*/PULSE_PROBE_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak
docker compose up -d --build
```

Open http://localhost:8080. Stop with `docker compose down`. The demo profile (`docker compose --profile demo up demo-status`) shows every status page state; it needs no `.env`.

## Heartbeat checks

A check of type `heartbeat` is for cron jobs and workers. The job calls `POST|GET /heartbeat/<id>` with `Authorization: Bearer <secret>`; no ping within `period + grace` opens an incident, and the next ping resolves it. See [Configuration](docs/configuration.md#heartbeat-checks), [REST API](docs/rest-api.md#getpost-heartbeatidsecret) and [Operation](docs/operation.md#heartbeat-checks).

## Manual incidents

Operators post incidents with timed updates through `POST /manual-incidents`, `/manual-incidents/:id/updates` and `/manual-incidents/:id/resolve`, and read them from `GET /manual-incidents`. Writes need an admin token from `PULSE_API_ADMIN_TOKENS_FILE` (copy `admin-tokens.example.json`); without it they answer `404`. See [REST API](docs/rest-api.md#manual-incidents) for the shapes, limits and `curl` examples.

## Health and metrics

`GET /healthz` is liveness: it answers `200 ok` without touching the database, also while the API shuts down. `GET /readyz` is readiness: `200 ok` when the database answers and the API is not shutting down, else `503` without error text. `GET /metrics` serves Prometheus text with check ids only: keep it on a private network. Logs are JSON lines (`PULSE_LOG_LEVEL`). The API stops cleanly on `SIGINT` and `SIGTERM` (exit 0). A configuration error prints one line `pulse-api: <message>` and exits with 2. See [Operation](docs/operation.md).

## Documentation

Start at [docs/index.md](docs/index.md):

- [Install](docs/install.md), [Configuration](docs/configuration.md) and [Concepts](docs/concepts.md)
- [REST API](docs/rest-api.md)
- [Operation](docs/operation.md) and [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)

Licensed under the MIT licence, see [LICENSE](LICENSE).
