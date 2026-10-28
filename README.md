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

See `checks.example.json`. The file is validated and upserted into the database at startup; existing state and results are kept. An invalid or unreadable file stops startup with an error.

## State rules

A check with no results is `unknown`. `down` from the first down result, `up` from an up result. The third consecutive down result opens an incident (if none is open); the first up result resolves it. `openedAt`/`resolvedAt` are the timestamps of those results. The counter is stored and survives restarts.

## Routes

- `POST /results` — body `Result`; 204 on success, 400 invalid body, 404 unknown `checkId`.
- `GET /checks` — checks with state.
- `GET /checks/:id/results?limit=N` — results newest first; `limit` defaults to 100 and is capped at 1000; 400 if `limit` is not a positive integer; 404 unknown check.
- `GET /incidents?status=open|resolved` — both when omitted, open ones first, then newest first; 400 on a bad status.

Other methods on these paths return 405, unknown paths 404, and request bodies over 1,000,000 bytes 413. Errors are `{"error": "..."}`. Types come from `@lorenzh/pulse-contract` (Git dependency pinned to a commit).
