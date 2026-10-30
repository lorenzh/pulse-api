# Development

This page holds what is specific to pulse-api. For how the repositories fit together and how a change goes from spec to pull request, see [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). The rules for code and tests are in [AGENTS.md](../AGENTS.md).

## Run

You need Bun 1.4.0.

```sh
bun install --frozen-lockfile
cp checks.example.json checks.json
cp tokens.example.json tokens.json   # edit the tokens first
bun start
```

`bun install` also installs the Lefthook pre-commit hook. Tests use a database in a `mkdtemp` directory, never `./pulse.db`.

## Code layout

| File                      | Job                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `src/main.ts`             | Reads the environment, wires the parts and starts the server.                            |
| `src/server.ts`           | HTTP routes, request validation and error mapping.                                       |
| `src/service.ts`          | All SQL, row mapping to contract types, quorum evaluation.                               |
| `src/state.ts`            | Pure rules: `applyResult` and `quorumStatus`.                                            |
| `src/db.ts`               | Schema (current version only).                                                           |
| `src/config.ts`           | Parsing of the checks file, the maintenance windows, the components and the tokens file. |
| `src/tokens.ts`           | Token rules and bearer authentication.                                                   |
| `src/retention.ts`        | Retention setting and the hourly cleanup.                                                |
| `src/location-silence.ts` | The `PULSE_LOCATION_SILENT_MS` setting.                                                  |
| `src/heartbeat.ts`        | The evaluator that writes `down` for heartbeat checks without a ping.                    |

Types come from `@lorenzh/pulse-contract` (a Git dependency pinned to a full commit SHA). Import them with `import type` only.

## Test

```sh
bun run check                     # lint, typecheck and tests, as CI does
bun test src/state.test.ts        # one file
bun test --test-name-pattern "<text>"
```

`bun test` fails below 80 % line coverage. Tests sit next to the code as `src/<module>.test.ts`. Each service has a test that starts its real server on port `0` and drives it over HTTP. Write the failing test first. A change to an endpoint or a response shape gets such a test, typed by the contract.

## Performance bench

`bench/` measures CPU time and memory of api, probe, status and notify under a fixed load, and the test and build CPU time of all seven repositories. `bun bench/run.ts --a <ref> --b <ref>` compares two versions with 5 interleaved rounds per side. The nightly workflow `.github/workflows/bench.yml` compares the baseline against `main`. CPU time and memory gate it; latency, throughput, wall-clock startup and image size are only reported, because hosted runners are too noisy for wall-clock numbers. `bun run bench:selftest` runs the harness self-tests (also in CI). It is not part of `bun test`. See [bench/README.md](../bench/README.md) for running it, changing a budget and reading a failure.

## Lint and format

Biome formats and lints (`bun run lint` to check, `bun run format` to fix). SonarJS runs through ESLint and limits cognitive complexity to 15 per function. The configuration comes from [pulse-config](https://github.com/lorenzh/pulse-config) (Biome, TypeScript, Lefthook and the ESLint setup) and brings TypeScript 6, while this repository uses TypeScript 7 (the `typescript7` dev dependency, run by `bun run typecheck`). `eslint.config.js` also ignores `.repos/` and `.bench/`. Never weaken the shared configuration to pass a check.

The Lefthook pre-commit hook (`lefthook.yml`) runs Biome and ESLint on staged files and rejects the commit on failure.

## CI

`.github/workflows/ci.yml` has three jobs:

- `check` uses the shared `check.yml` workflow of pulse-config (lint, typecheck, tests).
- `docker` builds the image, validates `compose.yaml` with `.env.example`, checks that the image holds no test files, and checks that `PULSE_STATUS_PORT=8090` is published.
- `compose-e2e` runs `scripts/compose-e2e.sh` against the real Compose stack. It proves that the four services start, become healthy and stay up, that `/readyz`, `/healthz` and `/metrics` of the API answer, that `docker stop` ends every service with exit code 0, that a check gets a state, that the status page answers, that a heartbeat check (`heartbeat-e2e`, period 2000, grace 1000, a throwaway secret in `compose/e2e/ro/checks.json`) goes down without a ping, opens an incident, shows missed periods in `/metrics`, answers `401` for a wrong secret, hides the secret in `GET /checks`, and resolves after a ping, that notify delivers `opened` and `resolved` for a heartbeat incident that opens after its first poll, that an HTTP check with `POST`, a JSON body, an `Authorization` header from the probe environment and a JSON assertion (`e2e-post`, answered by `compose/e2e/target.mjs`; the fixtures are in `compose.e2e.yaml` and `compose/e2e/ro/checks.json`) is up, goes down with the reasons `json /status: expected "ok", got "degraded"`, `HTTP 503 not in 200` and `json: invalid body`, and leaks neither the token nor the body into `GET /checks`, `/metrics`, the status proxy or the container logs, that a stopped service opens an incident which resolves and reaches the notify ledger, that an atomic replace (`mktemp` and `mv` over the file) followed by `SIGHUP` is served by `GET /checks`, on the writable directory mount and on the read-only one, that a changed checks file (`compose/e2e/ro/checks.json`) is picked up after `restart api` (only the API restarts, not the probe), that after the API was stopped for 35 s (`E2E_OUTAGE_SECONDS`) the probe delivers its buffered results, so that `GET /locations` shows the location `reporting` and `status-page` has no gap in its results larger than 1.5 intervals (this needs the probe buffer), that the volumes survive `down` and `up`, and that the demo profile starts and its cleanup keeps `api-data` and `notify-data`. It builds probe, status and notify from `main` of their repositories, so a break there fails this job.

The script sets `COMPOSE_FILE=compose.yaml:compose.e2e.yaml`, so every `docker compose` call sees the regular stack plus the e2e fixtures. Before it starts, a guard fails if `compose/checks.json` holds an id with `e2e`, or if `docker compose config --services` of `compose.yaml` alone lists anything but `api`, `probe`, `status` and `notify`. The regular stack never holds a down check or an incident.

Run the same test locally with `bash scripts/compose-e2e.sh`. It needs Docker Compose 2.23 or newer, network access, `curl` and `jq`, and takes a few minutes. It uses the project name `pulse-e2e`, so it does not touch your `pulse_*` volumes, and it publishes the ports 3000, 8080 and 8081. It creates `.env` from `.env.example` with a random token (`openssl rand -hex 16`) only if missing, restores `compose/e2e/ro/checks.json`, and removes its containers and volumes at the end. Timeouts can be set with `E2E_TIMEOUT_*` variables (see the top of the script).

## Documentation

These pages describe `main`. When behavior, a setting, an endpoint or a type changes, update the page in the same change. Every setting, key and route in the code must appear in the docs, and the docs must not name anything the code lacks. `README.md` keeps only the quick start and the links to these pages.
