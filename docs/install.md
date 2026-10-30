# Install

You can run pulse-api with Bun directly, as a single Docker image, or as part of the full pulse stack with Docker Compose.

## With Bun

You need Bun 1.4.0.

```sh
bun install --frozen-lockfile
cp checks.example.json checks.json
cp tokens.example.json tokens.json
```

Edit `tokens.json` first. The API rejects the placeholder tokens of the example file. Create a token with `openssl rand -hex 32` (see [Locations and tokens](concepts.md#locations-and-tokens)). Then start the API:

```sh
bun start
```

It listens on port 3000. The database is `./pulse.db`. All settings are in [Configuration](configuration.md).

Check that it runs:

```sh
curl http://localhost:3000/checks
```

The API only stores and serves data. Start a [pulse-probe](https://github.com/lorenzh/pulse-probe/blob/main/docs/install.md) to produce results.

## With Docker Compose

`compose.yaml` runs the whole stack: api, one probe, status and notify. It needs Docker Compose 2.23 or newer and access to github.com. The probe, status and notify images are built from `main` of their repositories.

```sh
cp .env.example .env
# Put a random token into .env. The placeholder in .env.example is rejected at start.
sed -i.bak "s/^PULSE_PROBE_TOKEN=.*/PULSE_PROBE_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak
docker compose up -d --build
```

Open http://localhost:8080. The example check (`compose/checks.json`, only `status-page`) probes the status page itself, so the stack works offline. Its state leaves `unknown` after the first 10 s interval.

Stop the stack with `docker compose down`. The `api-data` and `notify-data` volumes keep the database and the notify ledger for the next start. `docker compose down -v` deletes them.

| Service  | Image                | Port                          | Healthcheck   |
| -------- | -------------------- | ----------------------------- | ------------- |
| `api`    | `pulse-api:local`    | `127.0.0.1:3000` (not public) | `GET /readyz` |
| `probe`  | `pulse-probe:local`  | none                          | none          |
| `status` | `pulse-status:local` | `8080` (the status page)      | `GET /`       |
| `notify` | `pulse-notify:local` | none                          | none          |

The API stays non-public (`127.0.0.1:3000`). Port 8080 of `pulse-status` exposes a filtered, read-only subset of it: `GET /api/uptime`, `/api/checks`, `/api/maintenance` and `/api/incidents?status=open|resolved`. No other API path is proxied. The status page `/` and its static assets are served as well. Check targets, reasons and keywords are hidden by default (`PULSE_STATUS_HIDE_DETAILS`, see the pulse-status docs). If you show details, reasons can still reveal hosts or IPs.

All images run as the non-root `bun` user. `status` and `notify` wait for `api` to be healthy. `probe` waits for `api` and `status` to be healthy.

### The `.env` file

`.env` holds `PULSE_PROBE_TOKEN` and `PULSE_LOCATION`. `.env.example` has a placeholder token (`replace-with-...`). The API refuses to start with it, so replace it with your own token:

```sh
openssl rand -hex 32
```

Compose writes the API's tokens file from these two variables and gives the same two variables to the probe, so the location matches the token. Without a `.env` the token is empty. The API then stops at start with `token must be a string of at least 16 characters`. Copy `.env.example` to `.env` and set the token first. The Compose demo profile has its own public tokens in `compose.yaml` and still starts without `.env`. All Compose variables are listed in [Configuration](configuration.md#compose-variables).

### Ports

Change the host ports in `.env` or per command:

```sh
PULSE_STATUS_PORT=8090 docker compose up -d --build
```

The status page is then on http://localhost:8090. The API port (`PULSE_API_PORT`, default 3000) is always bound to 127.0.0.1.

### Adding checks

Edit `compose/checks.json` (format: [checks.json](configuration.md#checksjson)). The API reads the file once at start, so restart the API. The probe reloads its checks from the API on its own, within its reload interval:

```sh
docker compose restart api
```

`docker compose up -d` is not a reload step: it does not recreate the API when only the mounted file changed, and the API reads the checks only at start.

The compose file has one probe, so one location. A single location decides alone, so a check can open an incident with it. See [Quorum and incidents](concepts.md#quorum-and-incidents). For a second location, add a second probe service with its own `PULSE_LOCATION`, its own token and a matching entry in the tokens config.

### Notifications

The end-to-end test fixtures are not part of this stack. They live in `compose.e2e.yaml` and `compose/e2e/`, and only `scripts/compose-e2e.sh` uses them.

The notify config is `compose/notify.json`: one `file` channel that writes `/data/incidents.jsonl`. See the [pulse-notify docs](https://github.com/lorenzh/pulse-notify/blob/main/docs/index.md).

## API image alone

```sh
docker build --tag pulse-api:local .
docker run --rm -p 3000:3000 \
  -v "$PWD/checks.json:/config/checks.json:ro" \
  -v "$PWD/tokens.json:/config/tokens.json:ro" \
  -v pulse-api-data:/data \
  -e PULSE_CHECKS_FILE=/config/checks.json \
  -e PULSE_TOKENS_FILE=/config/tokens.json \
  pulse-api:local
```

The image runs as the non-root `bun` user with `bun src/main.ts`. It owns `/data` (database at `PULSE_DB=/data/pulse.db`), exposes port 3000 and has a healthcheck on `GET /readyz`. It contains no checks or tokens file: mount them.

## Demo profile

The `demo` Compose profile starts a self-contained pulse whose status page shows every state within five minutes. It needs Docker Compose 2.23 or newer and access to github.com. It needs no `.env`.

```sh
docker compose --profile demo up demo-status
```

Open http://localhost:8081. The `demo-` services have their own volumes and ports, so they never clash with the regular stack.

- `demo-status` listens on `PULSE_DEMO_STATUS_PORT` (default 8081).
- `demo-api` listens on `127.0.0.1:${PULSE_DEMO_API_PORT:-3001}`.
- `demo-init` writes the checks file, with maintenance windows relative to the start time.
- `demo-probe-a` (location `eu`) and `demo-probe-b` (location `us`) are the two probes.
- `demo-targets` serves HTTP endpoints driven by the time since start (`compose/demo/targets.mjs`).
- `demo-tls` serves HTTPS with a self-signed certificate valid for 5 days (`compose/demo/tls.sh`, an `openssl` image pinned by digest).

`depends_on` starts the dependencies. Plain `docker compose --profile demo up` also starts the regular services. They do not affect the demo, but without a `.env` the regular `api` exits with the token error and the regular `probe`, `status` and `notify` do not start.

| Check             | Target          | Expected state                                    | Appears                                                               |
| ----------------- | --------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| Always healthy    | `/up`           | up                                                | within 10 s                                                           |
| Slow endpoint     | `/slow`         | degraded (answers in 1.5 s, objective 500 ms)     | within 10 s                                                           |
| Flaky service     | `/flaky`        | down with an open incident, then up and resolved  | down from about 30 s, incident about 15 s later, resolved after 150 s |
| Database upgrade  | `/maintenance`  | maintenance (current window, target always fails) | within 10 s                                                           |
| Scheduled upgrade | `/up`           | up, upcoming maintenance window in 30 to 90 min   | within 10 s                                                           |
| TLS certificate   | `demo-tls:8443` | up, certificate valid for 5 days, `warnDays` 3    | within 10 s                                                           |

Times count from the start of `demo-targets`. `demo-init` computes the maintenance windows when it runs, and the API reads them at start only. The windows go stale after 15 minutes. To refresh them, remove the demo containers and volumes as described under cleanup below and start again.

The file `compose/demo/theme-white-label.json` is an example theme for the status page. It is not mounted by default. To use it, add this to `demo-status` in a `compose.override.yaml` and restart the service. The theme format is described in the [pulse-status theming docs](https://github.com/lorenzh/pulse-status/blob/main/docs/theming.md).

```yaml
services:
  demo-status:
    environment:
      PULSE_STATUS_THEME: /config/theme.json
    volumes:
      - ./compose/demo/theme-white-label.json:/config/theme.json:ro
```

Clean up with these two commands. They remove only the demo containers and the `demo-api-data` and `demo-config` volumes, and keep the regular stack and its volumes. Do not use `docker compose --profile demo down -v`: the profile includes every service, so `-v` also deletes `api-data` and `notify-data`. The volume names start with the project name `pulse`.

```sh
docker compose --profile demo rm -sf demo-init demo-api demo-targets demo-tls demo-probe-a demo-probe-b demo-status
docker volume rm pulse_demo-api-data pulse_demo-config
```

The two demo tokens in `compose.yaml` are public example values. Never use them for a real deployment.

## Next steps

- Configure your checks: [checks.json](configuration.md#checksjson).
- Read the data: [REST API](rest-api.md).
