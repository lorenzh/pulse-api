# pulse-api

Receives probe results, stores them in SQLite, computes up/down state and incidents, and serves REST.

## Run

```sh
cp checks.example.json checks.json
npm start
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PULSE_DB` | `./pulse.db` | SQLite file |
| `PULSE_CHECKS_FILE` | `./checks.json` | Checks definition |

`checks.json` is `{"checks":[{"id","name","url","intervalMs","timeoutMs?"}]}` (milliseconds; `timeoutMs` defaults to 5000 in the probe). It is validated and upserted into the database at startup; existing state and results are kept. `node:sqlite` prints an experimental warning.

## State rules

A check with no results is `unknown`. `down` from the first down result, `up` from an up result. The third consecutive down result opens an incident (if none is open); the first up result resolves it. `openedAt`/`resolvedAt` are the timestamps of those results. The counter is stored and survives restarts.

## Endpoints

- `POST /results` — body `Result`; 204, 400 invalid body, 404 unknown `checkId`.
- `GET /checks` — checks with state.
- `GET /checks/:id/results?limit=N` — newest first; default 100, max 1000 (larger values are capped); 404 unknown check.
- `GET /incidents?status=open|resolved` — both when omitted, open first, newest first; 400 on bad status.

Errors are `{"error": "..."}`. Types come from `@lorenzh/pulse-contract` (Git dependency pinned to a commit).

## Development

```sh
npm ci
npm run check   # typecheck and tests
```

Part of pulse — issues and specs live in https://github.com/lorenzh/pulse-meta
