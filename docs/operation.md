# Operation

## Start and restart

The API reads `checks.json`, the tokens file and its environment at start. It reloads `checks.json` while it runs (see [Changing checks](#changing-checks)). Restart it after a change to the tokens files or the environment.

After a change to the checks file, restart only the API. Probes reload their checks from the API on their own, within their reload interval (`PULSE_CHECKS_RELOAD_MS`, see the probe docs).

```sh
docker compose restart api
```

Use `restart`, not `docker compose up -d`: `up -d` does not recreate the API when only the mounted checks file changed, so the API keeps the checks it loaded at start (`src/main.ts` reads the file once).

Everything else is kept in the database, so a restart loses no state. The check counter and open incidents survive restarts.

## Database

The database is one SQLite file, at `PULSE_DB` (default `./pulse.db`, `/data/pulse.db` in the Docker image). The API opens the file in journal mode WAL with `synchronous = NORMAL`. A reader on a second connection, such as the [backup command](#backup-and-restore), is never blocked by a write. With `NORMAL` a crash or power loss can lose the last committed transactions, but never corrupts the file; probes re-send buffered results and `POST /results` is idempotent, so lost results are mostly sent again.

While the API runs, `pulse.db-wal` and `pulse.db-shm` sit next to `pulse.db`. The process user creates them in the same directory, so that directory must be writable (`/data` in the image is). SQLite's default auto-checkpoint (1000 pages, on commit) moves the WAL into the file. A clean shutdown checkpoints and removes both files. An older file in rollback-journal mode is switched to WAL at start; an older API version can open a WAL file.

If the file system does not support WAL (no shared memory, such as some network mounts), the start goes on in the old journal mode and logs one line `journal mode stays <mode>: WAL is not available for this file`. `synchronous` then stays `FULL`.

### Schema

The schema is versioned with `PRAGMA user_version`. At start the API creates missing tables, then runs every numbered step (`src/migrations.ts`) above the file's version, all in one transaction. A failing step rolls everything back and the start fails. Version 1 rebuilds `checks` to hold tcp, dns and domain checks; `results` and `incidents` are not touched. Version 2 makes `results` unique on (`check_id`, `location`, `timestamp`): it deletes duplicate rows, keeping the first by row id, and adds the unique index. The start logs `migration 2: removed <n> duplicate results, kept the first of each` when it deleted any. On a large database this step takes seconds (about 1.8 s for 1 million results in a local measurement).

- Upgrades are automatic. Back up the database file first (see [Backup and restore](#backup-and-restore)).
- A file whose `user_version` is higher than the program supports is refused at start with exit code 2 (`database schema version 2 is newer than this program supports (1); downgrades are not supported`). Downgrades are not supported: restore the backup (see [Backup and restore](#backup-and-restore)).

#### Rolling out a new check type

A new check type (tcp, dns, domain) needs every probe location updated first. An old probe logs `skipping invalid check <id>: ...` for a type it does not know, keeps running the other checks, and the new check stays `unknown` for that location. That `unknown` state is expected until the probe is updated. Order: update the contract users (probes, status), then add the check to the checks file.

The table `latency_daily` (daily p50 and p95 per check) is created with `CREATE TABLE IF NOT EXISTS` on every open, so a file from an older release gets it without a numbered step and `user_version` does not change. Back it up with the database file; it can be rebuilt from the results, so restoring a file without it is safe. The background backfill after the next start refills the closed days, and a read fills the days of the checks it returns.

#### Rolling out latency history and availability objectives

Roll out in this order:

1. Contract release with `CheckLatency`, `Slo` and `availabilityTarget`.
2. Probes: bump their contract pin to `6401721768c1996192c5cdadef7835d852015248` or later. A probe validates every check it receives and skips one with a field its contract does not know.
3. This API. `GET /probe/checks` is built from the stored check columns and never carries `availabilityTarget`, `slo` or any latency field, so an API upgrade does not break a probe that has not been updated. Setting `availabilityTarget` in the checks file is therefore safe before step 2, but the probes do not need the field to measure.
4. The status page: its proxy must allow `/api/latency` before it can draw the chart.

Timings measured on a database with 1 M results: the first `GET /checks` after start that builds `slo` values takes about 0.4 s. The backfill of the closed days computes for about 1.7 s in total, as background work after start, spread over many small batches. Later reads come from the cache.

The latency backfill starts 5 s after the API listens, so it is not part of the start. It computes one day of one check per batch and yields to waiting requests after each batch. Only closed days without a row are computed, so a restart on the same day computes nothing. After the first run it repeats hourly. The first run logs two lines, also when it stores nothing:

```text
latency rollup: backfill started (20 checks)
latency rollup: backfill done, stored 1780 days in 2412 ms
```

An hourly run logs `latency rollup: stored <N> days in <D> ms` only when it stored days. A failed run logs `latency rollup failed: <message>`. A shutdown waits for the batch in progress before it closes the database.

### Upgrades

1. Back up the database file (see [Backup and restore](#backup-and-restore)).
2. Stop the API and start the new version with the same `PULSE_DB`.
3. Look at the start log line to see that it came up (see [Logs](#logs)).

Do not open a database file of an older version with this version. Restore the backup to go back (see [Backup and restore](#backup-and-restore)).

A checks file whose heartbeat `secret` still starts with `replace-with-` (the example placeholder) stops the start with `checks[<i>].secret still has the example placeholder secret` and exit code 2. Replace the secret with `openssl rand -hex 32` and update the job that pings, or remove the check. An API that is already running rejects such a reload and keeps its config.

### Backup and restore

`bun run backup <file>` writes a consistent copy of the database at `PULSE_DB` to `<file>`. It works while the API serves traffic: it reads one snapshot on its own read-only connection and never blocks the API's writes. With Compose:

```sh
docker compose exec api bun run backup /data/backup-2026-10-31.db
docker compose cp api:/data/backup-2026-10-31.db ./
```

On success it prints one line with the numbers of the copy (not of the live file, which may have moved on):

```text
backup /data/backup-2026-10-31.db: schema version 2, checks 12, results 340512, incidents 7
```

- Exit code `0`: the backup is written. `2`: a wrong number of arguments, an empty argument, or a target that exists. `1`: any other error (missing source, missing target directory, copy, write or report failure). An error is one line `pulse-api backup: <message>` on stderr, with the paths and the SQLite message.
- It never overwrites a file: a target that exists, also a symlink, is refused. The target's directory must exist; it is not created. The copy is written to a temp file `.<name>.tmp-<pid>` in the same directory and then linked to the target name, so a failed run leaves no partial file. The command creates the temp file itself and refuses to run (exit 1) when anything already sits at that name, also a symlink; it never removes a file that it did not create. It writes the copy through the file it created, not by name, so a temp file that someone renames or replaces during the run gets no data: the run then fails with exit 1 and leaves its own file empty. The copy has mode `0600` (owner only); use `chmod` if another user must read it. On a file system without hard links it renames the temp file after a second check; another process that creates the target between that check and the rename would lose its file.
- It needs free space for a full copy in the target's file system, and memory for one copy of the file: it reads the snapshot into memory before it writes it.
- The copy is in rollback-journal mode, like a `VACUUM INTO` copy; the API switches it to WAL when it opens it. Unlike `VACUUM`, it keeps free pages, so the copy has the size of the live file.
- It opens the source read-only and never migrates or changes it; any schema version is accepted. A missing source is an error and is not created.
- It also works with the API stopped. Then SQLite creates `pulse.db-wal` and `pulse.db-shm` and leaves them, so the source directory must be writable. Run it as the image's default user (no `docker compose exec -u root`), or those files can end up owned by root.
- While the backup reads, a checkpoint cannot move past its snapshot, so `pulse.db-wal` grows for the length of the backup. A later checkpoint resets it.

A cold copy (`cp pulse.db`) is safe only after a clean stop, when no `pulse.db-wal` is left. After a crash or `SIGKILL` the last transactions can still be in `pulse.db-wal`: use the backup command, or copy `pulse.db-wal` together with the file.

To restore:

1. Stop the API.
2. Replace `pulse.db` at `PULSE_DB` with the backup file.
3. Delete `pulse.db-wal` and `pulse.db-shm` if they exist. A stale WAL belongs to the old file and must not be applied to the restored one.
4. Start the API.

A backup from an older version is migrated at start. A file with a newer schema version is refused with exit code 2 (see [Schema](#schema)). With Compose the file is in the `api-data` volume.

## Retention and disk space

Cleanup of old results runs at start and then hourly. See [Retention](concepts.md#retention) for the rules. Set the number of days with `PULSE_RETENTION_DAYS`. The latency rollups (`latency_daily`, one small row per HTTP check and day) are deleted with the same cutoff, which is never inside the 90-day window, and when their check is gone.

Rows per check per day are `86400 / interval_s * locations`. A row takes roughly 100 bytes with its indexes in a measured database of minimal rows (129,600 rows, 60 s interval, about 13 MB). Allow about 250 bytes for rows with reasons. Example: 60 s interval, 1 location and 90 days give 129,600 rows, roughly 30 MB per check.

The file does not shrink after deletes. SQLite reuses the freed pages. To reclaim the space, run `VACUUM` with the API stopped:

```sh
sqlite3 /path/to/pulse.db 'VACUUM'
```

This command was not run for this page; it needs the `sqlite3` tool.

## Manual incidents

Enable them with `PULSE_API_ADMIN_TOKENS_FILE` (see [Configuration](configuration.md#admin-tokensjson)); the `curl` examples are in [REST API](rest-api.md#write-routes). Counters: `pulse_api_manual_incidents_created_total` and `pulse_api_manual_incidents_resolved_total`, without labels. The start log says `manualIncidents` is `writable` or `off` and counts `adminTokens`. While it is `off`, the reads are empty even when the database holds incidents. The tables are created on start in an older database; nothing else changes. Rotate admin tokens like probe tokens: add the new one, restart, remove the old one, restart. Every write logs `manual incident write` (with the admin token name) or `manual incident write failed`, and every failed authentication logs `admin auth failed` (see [Logs](#logs)).

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

The checks file is the only source of truth. Change it by hand or through the [admin routes](rest-api.md#admin-config-routes); the API applies the change without a restart.

**Hot reload.** The API looks at the file every `PULSE_CHECKS_RELOAD_INTERVAL_MS` (default 5000; `0` turns it off). One look is one `stat`. Only when the modification time, size or inode changed does it read and hash the file; the same bytes (a `touch`) change nothing. It does not use `fs.watch`; the look sees a replaced file by its inode. A rename over a single-file bind mount does not reach the container (it keeps the old inode), so mount the directory that holds the file. An edit that keeps mtime, size and inode is not seen by the look: send `SIGHUP`, which always reads, hashes and applies the file.

```sh
kill -HUP "$(pidof bun)"                  # on the host
docker compose kill -s HUP api            # with Compose
```

A valid file is applied in one step: checks are upserted, components, maintenance windows and heartbeat secrets are replaced, and the read cache is cleared. A changed check field reaches a probe at its next fetch of `GET /probe/checks`. State of an unchanged heartbeat check is kept, and a changed secret works for the next ping. Existing manual incidents that name a removed component stay readable and can be resolved; a new one for it is refused. Maintenance windows that are active at the reload end at their own times; a removed window ends at once.

An invalid or unreadable file is not applied. The API keeps the running configuration and logs one `warn` line, `config reload rejected: <path>: <message>` (the message never quotes a value), and counts `pulse_api_config_reload_total{result="invalid"}`. The same bad file is not logged again at every look; fix it or send `SIGHUP` to log it again. A start with an invalid file still fails.

Checks that you remove from the file stay in the database with their results, but become inactive. The API does not delete checks. An inactive check is left out of `GET /checks` and `GET /uptime`, and `POST /results` for it answers `404 unknown check`. Its results and incidents stay readable. At the reload an open incident of a removed check is resolved (`resolvedAt` is the reload time, one log line per incident) and the check state is reset, so `notify` may send a "resolved" notification. If you add the check again, it becomes active with its history.

**Writing through the API.** Set `PULSE_API_ADMIN_TOKENS_FILE`. Every write needs `If-Match` with the `ETag` of the last read:

```sh
API=http://127.0.0.1:3000
TOKEN=$(cat /path/to/admin-token)
ETAG=$(curl -sS -D - -o /dev/null "$API/admin/config" -H "Authorization: Bearer $TOKEN" | tr -d '\r' | sed -n 's/^[Ee][Tt]ag: //p')
curl -sS -X POST "$API/admin/checks" -H "Authorization: Bearer $TOKEN" -H "If-Match: $ETAG" \
  -H 'Content-Type: application/json' \
  -d '{"id":"blog","name":"Blog","url":"https://blog.example/","intervalMs":60000}'
```

A write needs a checks file that the API can replace: it writes a temp file in the same directory and renames it over the file. A read-only mount, or a single file bind-mounted into the container, answers `503` (for example `checks file is read-only (EROFS)`). `compose.yaml` mounts the directory read-only (`./compose:/config:ro`), so a hand edit, also a save by rename, reaches the container. To opt in to writes, replace it with a writable directory mount (`./compose:/config`, with a directory that the container user may write). The file keeps its mode and, when the process may set it, its owner. The write rewrites the file as JSON with two spaces: comments and layout of a hand-made file are not kept. A hand edit and a write at the same moment can still race in the last millisecond before the rename; the revision check makes this rare, not impossible. A write runs in this order: temp file, `fsync`, revision check, rename, `fsync` of the directory, then apply. When a step after the rename fails (the directory `fsync`, or applying to the database), the write answers `500` (`503` for a read-only cause), but the new file is already in place. The running configuration and the `ETag` stay at the old revision, and the next reload (a look or `SIGHUP`) applies the file. Until then a write gets `412`.

Each successful write logs one `info` line `config write` with the token name, kind, action and id; a failed write logs one `warn` line with the status and kind. Metrics: `pulse_api_config_writes_total{kind,action,result}`.

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
- Only a ping changes a heartbeat check: `POST /results` for it answers `403` `heartbeat checks accept only pings`.
- To rotate a secret, edit `checks.json` (or `PUT /admin/checks/:id` with a new `secret`); the API reloads it. The last ping is kept in the database. The secret is not stored there.

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
- `admin auth failed` (warn): A request to `/admin/*` or a manual-incident write had no valid admin token (`401` or `403`). Fields: `route` (the route pattern, such as `/admin/checks/:id`), `status`, `token` (`missing` without a Bearer header, `probe` for a probe token, `unknown` otherwise) and `suppressed`. One line per route, status and kind per minute; `suppressed` counts the failures of that key dropped since its previous line. A dropped count shows only in the next line of the same key; with no later failure it is only in `pulse_api_admin_auth_failures_total`, which counts every failure.
- `manual incident write` (info): A manual-incident write succeeded. Fields: `token` (the admin token name), `action` (`create`, `update`, `resolve`, `delete`) and `id`.
- `manual incident write failed` (warn): A manual-incident write failed after authentication (`400`, `404`, `409`, `413`). Fields: `status`, `action` and, except for `create`, `id`.

A log field named `time`, `level` or `msg` does not replace the base key.

A configuration or startup error is not a JSON line: it is one line `pulse-api: <message>` on stderr with exit code 2. See [Exit codes](configuration.md#exit-codes).

The log never prints token values, heartbeat secrets, header values or request bodies. Admin token **names** do appear.

With Compose: `docker compose logs api`.

## Probe locations

`GET /locations` lists each probe location with `reporting` or `silent` ([REST API](rest-api.md#get-locations)); the silent threshold is `PULSE_LOCATION_SILENT_MS` ([Configuration](configuration.md)). The metric `pulse_api_location_last_result_timestamp_seconds{location}` is the newest accepted result timestamp. Alert on silence, for example `time() - pulse_api_location_last_result_timestamp_seconds > 300`. The metric uses the result timestamp, so after a long outage it lags until a probe has delivered its buffered results; `GET /locations` uses the receive time and is `reporting` as soon as the probe delivers.

A probe that could not reach the API keeps its results in a bounded buffer and re-sends them in order. `POST /results` is idempotent, so a re-sent result that the API already stored is safe. Replayed results are processed like live ones with their original timestamps (they are not late unless they arrive out of order), so a replay can open or resolve an incident with an old time and notify can send late notifications after an outage. The API rejects results older than 7 days.

## Health and metrics

`GET /healthz` is liveness: `200 ok`, no database access, also while the API shuts down (it used to answer `503` then). `GET /readyz` is readiness: `200 ok` when `SELECT 1` works and the API is not shutting down, else `503` with a short text and no database error. The image `HEALTHCHECK` and every gate on the API use `/readyz`. `GET /metrics` returns Prometheus text (content type `text/plain; version=0.0.4; charset=utf-8`, with `# HELP` lines). A wrong method on these three paths (also `HEAD`) answers `405` with the JSON body `{"error":"method not allowed"}` and the header `Allow: GET`, like every other API route. None needs a token. See [GET /healthz](rest-api.md#get-healthz) and [GET /metrics](rest-api.md#get-metrics). `/metrics` lists check ids: keep it on a private network.

## Shutdown

`SIGINT` and `SIGTERM` are handled from the first line of the process. The API then answers `/readyz` with `503`, stops accepting connections, closes idle ones, stops the retention timer (no run starts after that), waits for open requests and for the cleanup run in progress, closes the database and exits with code 0. The wait is bounded by 5 s inside the API, with a 1 s backstop in `pulse-kit`'s `runService`. When the bound is hit, the cleanup is told to stop after its current batch (a batch is synchronous) and the database closes only after it ended; then the API logs a `warn` line, drops the remaining connections and still exits with 0. A second signal changes nothing. `docker stop` therefore returns well within its default 10 s.
