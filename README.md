# pulse-api

[![CI](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-api/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. pulse-api is its backend: it receives probe results, stores them in SQLite, computes up/down state and incidents, and serves them over REST.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared types. [pulse-probe](https://github.com/lorenzh/pulse-probe) reads checks from it and posts results to it, and [pulse-status](https://github.com/lorenzh/pulse-status) reads from it to render the status page.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.

## Install, test, run

Requires Node >= 24.

```sh
npm ci
npm run check   # lint, typecheck and tests
cp checks.example.json checks.json
npm start
```

`node:sqlite` prints an experimental warning on start; this is expected.

## Docker and Compose

`compose.yaml` runs the whole stack: api, one probe, status and notify. It needs Docker Compose >= 2.23 and access to github.com (the probe, status and notify images are built from `main` of their repositories, so in-flight branches are not used).

```sh
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080. The example check (`compose/checks.json`) probes the status page itself, so the stack works offline; its state leaves `unknown` after the first 10 s interval. Stop with `docker compose down`; the `api-data` and `notify-data` volumes keep the database and the notify ledger for the next `docker compose up`. `docker compose down -v` deletes them.

| Service  | Image                | Port                          | Healthcheck   |
| -------- | -------------------- | ----------------------------- | ------------- |
| `api`    | `pulse-api:local`    | `127.0.0.1:3000` (not public) | `GET /checks` |
| `probe`  | `pulse-probe:local`  | none                          | none          |
| `status` | `pulse-status:local` | `8080` (the status page)      | `GET /`       |
| `notify` | `pulse-notify:local` | none                          | none          |

All images run as the non-root `node` user. `status`, `probe` and `notify` wait for `api` to be healthy.

### Token

`.env` holds `PULSE_PROBE_TOKEN` and `PULSE_LOCATION`. The example token in `.env.example` is public: replace it (`openssl rand -hex 32`) before you expose the stack. Compose generates the API's tokens file from these two variables (a `configs:` entry with `content:`) and gives the same two variables to the probe, so the location matches the token. Without a `.env`, Compose stops with an error.

### Adding checks

Edit `compose/checks.json` (format: [Checks file](#checks-file)), then recreate the API and restart the probe, which reads its checks once at startup:

```sh
docker compose up -d
docker compose restart probe
```

One probe is one location, and the API opens an incident only when at least two locations report a check down. With the single probe of this Compose file a check can be `down`, but no incident opens, and notify has nothing to send. Add a second probe service with its own `PULSE_LOCATION`, a matching entry in the tokens config and its own token to get incidents.

### Settings

Every service reads its settings from the environment; set them in `compose.yaml` or `.env`. The tables are the single source: api [Settings](#settings) (image defaults `PULSE_DB=/data/pulse.db`, `PORT=3000`), [probe](https://github.com/lorenzh/pulse-probe#settings), [status](https://github.com/lorenzh/pulse-status#settings) and [notify](https://github.com/lorenzh/pulse-notify#configuration). The notify config is `compose/notify.json`: one `file` channel writing `/data/incidents.jsonl`.

### API image alone

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

The image runs as the non-root `node` user with `node src/main.ts`, owns `/data` (database at `PULSE_DB=/data/pulse.db`), exposes 3000 and has a healthcheck on `GET /checks`. It contains no checks or tokens file; mount them.

## Formatting and linting

Biome formats and lints the code (`biome.json`). SonarJS recommended rules run through ESLint with cognitive complexity limited to 15; the ESLint setup comes from `@lorenzh/pulse-config`, which installs it nested with TypeScript 6 while the repository uses TypeScript 7 (`.npmrc` sets `install-strategy=nested`; `eslint.config.js` also ignores `.repos/`). Line coverage must be at least 80 %. Checks: Biome, SonarJS via ESLint (cognitive complexity ≤ 15), line coverage ≥ 80 % — run `npm run lint` and `npm test`. `npm run format` applies Biome fixes. `npm ci` installs a Lefthook pre-commit hook (`lefthook.yml`) that runs Biome and ESLint on staged files and rejects the commit on failure.

## Settings

| Env                    | Default         | Meaning                     |
| ---------------------- | --------------- | --------------------------- |
| `PORT`                 | `3000`          | HTTP port                   |
| `PULSE_DB`             | `./pulse.db`    | SQLite file                 |
| `PULSE_CHECKS_FILE`    | `./checks.json` | Checks definition           |
| `PULSE_TOKENS_FILE`    | `./tokens.json` | Probe tokens                |
| `PULSE_RETENTION_DAYS` | `90`            | Days of raw results to keep |

`PULSE_RETENTION_DAYS` must be an integer of at least 90 (the `/uptime` window); anything else stops startup with an error. Retention is counted in whole UTC days including today, so results before the start of the UTC day `PULSE_RETENTION_DAYS - 1` days ago are deleted. The newest result of each check and location is always kept, and incidents are never deleted. Cleanup runs at startup and then hourly, in batches of 1000 rows, and logs the number of deleted rows when it is above 0.

## Disk usage

Rows per check per day = `86400 / interval_s x locations`. A row takes roughly 100 bytes with its three indexes in a measured database of minimal rows (129,600 rows, 60 s interval, about 13 MB); allow about 250 bytes for rows with reasons. Example: 60 s interval, 1 location, 90 days = 129,600 rows, roughly 30 MB per check.

The database file does not shrink after deletes; SQLite reuses the freed pages. Run `VACUUM` manually (with the API stopped) to reclaim space.

## Probe tokens

`POST /results` needs a probe token: `Authorization: Bearer <token>`. The token fixes the probe's location. Read routes stay public.

`tokens.json` (path in `PULSE_TOKENS_FILE`, kept out of git; copy `tokens.example.json`) is `{"tokens": [{"location": "east", "token": "<secret>"}]}`. Rules:

- At least one entry. The API exits at startup with a message if the file is missing, not valid JSON or invalid. Messages never print token values; the startup log only counts tokens and locations.
- `location`: non-empty, at most 64 characters after trim.
- `token`: at least 16 characters, unique across the file. The placeholder values from `tokens.example.json` are rejected.
- A location may have several tokens (for rotation).

Create a token with `openssl rand -hex 32`.

Responses on `POST /results`, checked in this order: 405 wrong method; 401 `{"error":"unauthorized"}` with `WWW-Authenticate: Bearer` for a missing, malformed or unknown token (the header is `Bearer`, case-insensitive, one space, a non-empty token); then body size (413), JSON (400), validation (400); 403 `{"error":"location does not match token"}` if the body `location` differs from the token's (after trim); 404 unknown check. 401 comes before 400 and 404, so callers without a token learn nothing about checks. Nothing is stored on a rejection.

Location rule: a result without `location` (or a blank one) is stored under the token's location, not `default`. The probe's `PULSE_LOCATION` must equal its token's location, otherwise every result gets 403.

Rotation: add the new token to `tokens.json`, restart the API (tokens load at startup only), switch the probe to the new token, remove the old token, restart the API.

Rollout: give probes their tokens first (an old API ignores the header), then enable tokens on the API. Otherwise ingestion stops.

Tokens travel in clear over plain HTTP: run the API behind TLS or on a private network.

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

- `POST /results` — body `Result`, bearer token required; 204 on success, 401 no valid token, 400 invalid body, 403 location does not match the token, 404 unknown `checkId`.
- `GET /checks` — checks with state.
- `GET /uptime` — `CheckUptime[]`, one entry per check in `GET /checks` order: 90 UTC calendar days (oldest first, the last is today per the service clock) with `date`, `uptime` (percent, unrounded; `degraded` counts as up, all locations count, maintenance is not subtracted; `null` without results) and `results`, plus the result-weighted 90-day `uptime` (`null` without results). Results before the window or after now are ignored. Computed with one aggregate query per check.
- `GET /checks/:id/results?limit=N` — results newest first; `limit` defaults to 100 and is capped at 1000; 400 if `limit` is not a positive integer; 404 unknown check.
- `GET /incidents?status=open|resolved` — both when omitted, open ones first, then newest first; 400 on a bad status.

- `GET /maintenance?checkId=` — windows (`MaintenanceWindow[]`, epoch ms, `[start, end)`) with `end > now`, sorted by `start` then `checkId`; `checkId` is an optional filter. A window is current when `start <= now`, upcoming otherwise.

Other methods on these paths return 405, unknown paths 404, and request bodies over 1,000,000 bytes 413. Errors are `{"error": "..."}`. Types come from `@lorenzh/pulse-contract` (Git dependency pinned to a commit).

Licensed under the MIT licence, see [LICENSE](LICENSE).
