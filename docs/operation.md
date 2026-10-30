# Operation

## Start and restart

The API reads `checks.json`, the tokens file and its environment once at start. It has no reload. Restart it after any change to these.

After a change to the checks file, restart only the API. Probes reload their checks from the API on their own, within their reload interval (`PULSE_CHECKS_RELOAD_MS`, see the probe docs).

```sh
docker compose restart api
```

Use `restart`, not `docker compose up -d`: `up -d` does not recreate the API when only the mounted checks file changed, so the API keeps the checks it loaded at start (`src/main.ts` reads the file once).

Everything else is kept in the database, so a restart loses no state. The check counter and open incidents survive restarts.

## Database

The database is one SQLite file, at `PULSE_DB` (default `./pulse.db`, `/data/pulse.db` in the Docker image). The API does not set a journal mode, so SQLite uses its default (a rollback journal). In a run of the API with the example files, the directory held only `pulse.db`; there were no `-wal` or `-shm` files. A short-lived `pulse.db-journal` file can exist while a write runs.

### Schema migrations

The schema is created at start (`CREATE TABLE IF NOT EXISTS`). Then `src/db.ts` checks the columns of `results` and `checks` and adds the ones that are missing (`location`, `cert_days_left`, `attempts`, `late` and the check columns for TLS, retries and `keyword`), and creates the indexes `results_by_location` and `results_by_time`. Old rows get the defaults (`location` is `default`, `attempts` is 1). The `late` column is backfilled once, when it is added. There is no separate migration command, and no down migration.

### Upgrades

1. Back up the database file (see below).
2. Stop the API and start the new version with the same `PULSE_DB`.
3. Look at the start log line to see that it came up (see [Logs](#logs)).

A database that a newer version migrated may not work with an older version. Restore the backup to go back.

### Backup and restore

The tested method is a file copy with the API stopped:

```sh
# stop the API first
cp /path/to/pulse.db /path/to/backup/pulse.db
```

To restore, stop the API, put the file back at `PULSE_DB` and start the API. With Compose the file is in the `api-data` volume. No other method has been tested, and the API has no backup command. Do not copy the file while the API runs.

## Retention and disk space

Cleanup of old results runs at start and then hourly. See [Retention](concepts.md#retention) for the rules. Set the number of days with `PULSE_RETENTION_DAYS`.

Rows per check per day are `86400 / interval_s * locations`. A row takes roughly 100 bytes with its indexes in a measured database of minimal rows (129,600 rows, 60 s interval, about 13 MB). Allow about 250 bytes for rows with reasons. Example: 60 s interval, 1 location and 90 days give 129,600 rows, roughly 30 MB per check.

The file does not shrink after deletes. SQLite reuses the freed pages. To reclaim the space, run `VACUUM` with the API stopped:

```sh
sqlite3 /path/to/pulse.db 'VACUUM'
```

This command was not run for this page; it needs the `sqlite3` tool.

## Manual incidents

Enable them with `PULSE_API_ADMIN_TOKENS_FILE` (see [Configuration](configuration.md#admin-tokensjson)); the `curl` examples are in [REST API](rest-api.md#write-routes). Counters: `pulse_api_manual_incidents_created_total` and `pulse_api_manual_incidents_resolved_total`, without labels. The start log says `manualIncidents` is `writable` or `read-only` and counts `adminTokens`. The tables are created on start in an older database; nothing else changes. Rotate admin tokens like probe tokens: add the new one, restart, remove the old one, restart.

Upgrade order: contract, then status and notify, then api. Status and notify treat a `404` from `/manual-incidents` of an older api as no incidents.

## Token rotation

Tokens are read at start. Restart the API to rotate. A location may have several tokens, so rotation needs no gap:

1. Add the new token to the tokens file, next to the old one.
2. Restart the API.
3. Give the probe the new token (`PULSE_PROBE_TOKEN`) and restart the probe.
4. Remove the old token from the tokens file.
5. Restart the API.

To turn tokens on for an existing setup, give the probes their tokens first (an old API ignores the header), then enable tokens on the API. Otherwise ingestion stops.

Changing a probe's location means changing both `PULSE_LOCATION` of the probe and the `location` of its token. They must be equal, or every result gets `403`.

## Changing checks

Edit `checks.json` and restart the API. The probes follow within their reload interval. The file is upserted: checks that you remove from the file stay in the database with their results, but become inactive. The API does not delete checks.

An inactive check is left out of `GET /checks` and `GET /uptime`, and `POST /results` for it answers `404 unknown check`. Its results and incidents stay readable. At the restart, an open incident of a removed check is resolved (`resolvedAt` is the startup time, one log line per incident) and the check state is reset, so `notify` may send a "resolved" notification. If you add the check again, it becomes active with its history.

## Heartbeat checks

Configure a [heartbeat check](configuration.md#heartbeat-checks) and let the job ping it. Add the probe change first: a probe that does not know the type would run it as HTTP. Example for cron, every 5 minutes (use `period` 300000):

```cron
*/5 * * * * curl -fsS -m 10 --retry 3 -H "Authorization: Bearer $PULSE_HB_SECRET" https://pulse.example.com/heartbeat/nightly-backup >/dev/null
```

Path form, for a plain `curl` where a header is awkward:

```sh
curl -fsS -m 10 --retry 3 https://pulse.example.com/heartbeat/nightly-backup/<secret>
```

Secret handling:

- Prefer the header form. The path form puts the secret in the URL, and reverse proxies, cron mail and shell history can log a URL. Redact `/heartbeat/*/` in proxy access logs.
- The API has no access log and never logs the path of a request. Its metrics label the route `/heartbeat/:id`.
- Use `curl -fsS` without `-v`.
- To rotate a secret, edit `checks.json` and restart the API. The last ping is kept in the database. The secret is not stored there.

## Logs

The API writes JSON lines: `{"time":"<ISO 8601>","level":"info","msg":"...", ...fields}`. `info` and `debug` go to stdout, `warn` and `error` to stderr. `PULSE_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the lowest level that is written. There is no log file.

- `listening` (info): The API is ready. Fields: `port`, `checks`, `maintenanceWindows`, `checksFile`, `db`, `retentionDays`, `probeTokens`, `locations`, `tokensFile`.
- `retention: deleted <n> results` (info): A cleanup deleted rows (results and resolved manual incidents). Silent when it deletes none.
- `retention failed: <message>` (info): A cleanup failed. The next run is still scheduled.
- `check "<id>" removed from the checks file: incident resolved` (info): One line per incident resolved at start.
- `request failed` (error): An unexpected failure in a request (`500`). The field `error` holds the stack.
- `shutdown bound reached: closing open connections` (warn): The shutdown took longer than 5 s.
- `stopped` (info): The shutdown is done.
- `startup failed` (error): An unexpected failure at start. The process exits with code 1.
- `shutting down` (info): A signal arrived. Field: `signal`.

A log field named `time`, `level` or `msg` does not replace the base key.

A configuration or startup error is not a JSON line: it is one line `pulse-api: <message>` on stderr with exit code 2. See [Exit codes](configuration.md#exit-codes).

The log never prints token values.

With Compose: `docker compose logs api`.

## Health and metrics

`GET /healthz` is liveness: `200 ok`, no database access, also while the API shuts down (it used to answer `503` then). `GET /readyz` is readiness: `200 ok` when `SELECT 1` works and the API is not shutting down, else `503` with a short text and no database error. The image `HEALTHCHECK` and every gate on the API use `/readyz`. `GET /metrics` returns Prometheus text (content type `text/plain; version=0.0.4; charset=utf-8`, with `# HELP` lines). A wrong method on these three paths (also `HEAD`) answers `405` with the JSON body `{"error":"method not allowed"}` and the header `Allow: GET`, like every other API route. None needs a token. See [GET /healthz](rest-api.md#get-healthz) and [GET /metrics](rest-api.md#get-metrics). `/metrics` lists check ids: keep it on a private network.

## Shutdown

`SIGINT` and `SIGTERM` are handled from the first line of the process. The API then answers `/readyz` with `503`, stops accepting connections, closes idle ones, stops the retention timer (no run starts after that), waits for open requests and for the cleanup run in progress, closes the database and exits with code 0. The wait is bounded by 5 s inside the API, with a 1 s backstop in `pulse-kit`'s `runService`. When the bound is hit, the cleanup is told to stop after its current batch (a batch is synchronous) and the database closes only after it ended; then the API logs a `warn` line, drops the remaining connections and still exits with 0. A second signal changes nothing. `docker stop` therefore returns well within its default 10 s.
