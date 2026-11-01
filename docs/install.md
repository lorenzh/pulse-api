# Install

You can run pulse-api with Bun directly, as a single Docker image, or as part of the full pulse stack with Docker Compose.

## With Bun

You need Bun 1.4.0.

```sh
bun install --frozen-lockfile
cp checks.example.json checks.json
cp tokens.example.json tokens.json
```

Edit `tokens.json` first. The API rejects the placeholder tokens of the example file. In `checks.json`, replace the placeholder `secret` of the `nightly-backup` heartbeat check, or remove that check: the API also rejects it. Create a token with `openssl rand -hex 32` (see [Locations and tokens](concepts.md#locations-and-tokens)). Then start the API:

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

The Compose setups of the whole stack live in [pulse-deploy](https://github.com/lorenzh/pulse-deploy). Use its [`full`](https://github.com/lorenzh/pulse-deploy/blob/main/full/README.md) setup to run api, probe, status, notify and console, and its [`demo`](https://github.com/lorenzh/pulse-deploy/blob/main/demo/README.md) setup to see every status page state. Their READMEs describe the tokens, ports, checks and volumes.

## API image alone

```sh
docker build --tag pulse-api:local .
docker run --rm -p 3000:3000 \
  -v "$PWD/config:/config:ro" \
  -v pulse-api-data:/data \
  -e PULSE_CHECKS_FILE=/config/checks.json \
  -e PULSE_TOKENS_FILE=/config/tokens.json \
  pulse-api:local
```

The image runs as the non-root `bun` user with `bun --no-env-file src/main.ts`. It owns `/data` (database at `PULSE_DB=/data/pulse.db`), exposes port 3000 and has a healthcheck on `GET /readyz`. It contains no checks or tokens file: mount a directory with `checks.json` and `tokens.json` inside. Do not mount the two files singly: a single-file bind mount keeps the old inode and does not see an atomic replace (editor save, `sed -i`), so hot reload misses the change.

The image starts Bun with `--no-env-file`, so neither the API nor its healthcheck reads `.env` files, also not ones mounted into `/app`. Settings come from the container environment (`-e`, `docker run --env-file` read on the host, Compose `environment:`/`env_file:`) and the documented setting files (`PULSE_CHECKS_FILE`, `PULSE_TOKENS_FILE`). `bun start` from source still loads `.env` files as Bun does by default.

## Next steps

- Configure your checks: [checks.json](configuration.md#checksjson).
- Read the data: [REST API](rest-api.md).
