# Operation

## Start and restart

The API reads its environment at start, and the token files only until their one-time import (see [Token import](configuration.md#token-import)). Tokens are managed over HTTP and need no restart.

A change to `checks.json` needs no restart: the API reloads the file while it runs, or at once on `SIGHUP` (see [Changing checks](#changing-checks)). Probes then reload their checks from the API on their own, within their reload interval (`PULSE_CHECKS_RELOAD_MS`, see the probe docs).

The `docker compose …` commands on this page run inside your pulse-deploy setup directory, for example `cd pulse-deploy/full`.

A change to the environment needs a new process. After you change `environment:` or `env_file:` in the Compose file, recreate the container:

```sh
docker compose up -d api
```

`docker compose restart api` restarts the same container with its old environment, so it does not apply a changed `environment:` or `env_file:`.

Everything else is kept in the database, so a restart loses no state. The check counter and open incidents survive restarts.

## Database

The database is one SQLite file, at `PULSE_DB` (default `./pulse.db`, `/data/pulse.db` in the Docker image). The API opens the file in journal mode WAL with `synchronous = NORMAL`. A reader on a second connection, such as the [backup command](#backup-and-restore), is never blocked by a write. With `NORMAL` a crash of the API process loses no committed transaction. A power loss or an operating system crash can lose the last committed transactions, but does not corrupt the file. A probe forgets a result once the API answered `204`, so it never re-sends such a lost result: it is gone. `POST /results` is idempotent, so a re-send of a result that is already stored is safe, but this recovers nothing.

While the API runs, `pulse.db-wal` and `pulse.db-shm` sit next to `pulse.db`. The process user creates them in the same directory, so that directory must be writable (`/data` in the image is). SQLite's default auto-checkpoint (1000 pages, on commit) moves the WAL into the file. A clean shutdown checkpoints and removes both files. An older file in rollback-journal mode is switched to WAL at start; an older API version can open a WAL file.

If the file system does not support WAL (no shared memory, such as some network mounts), the start goes on in the old journal mode and logs one line `journal mode stays <mode>: WAL is not available for this file`. `synchronous` then stays `FULL`. In both modes the durable audit statements of a config write run at `synchronous = EXTRA`, which also syncs the directory after a commit in this fallback (see [Audit durability](#audit-durability)).

### Schema

The schema is versioned with `PRAGMA user_version`. At start the API creates missing tables, then runs every numbered step (`src/migrations.ts`) above the file's version, all in one transaction. A failing step rolls everything back and the start fails. Version 1 rebuilds `checks` to hold tcp, dns and domain checks; `results` and `incidents` are not touched. Version 2 makes `results` unique on (`check_id`, `location`, `timestamp`): it deletes duplicate rows, keeping the first by row id, and adds the unique index. The start logs `migration 2: removed <n> duplicate results, kept the first of each` when it deleted any. On a large database this step takes seconds (about 1.8 s for 1 million results in a local measurement). Version 3 adds the empty table `uptime_daily`; nothing is computed in the step. Like every step, it makes the start run the foreign key check over the whole file once, before the API listens. In local measurements `/readyz` answered after 156 ms on 864,000 results and after 762 ms on 8.64 million results, against about 105 ms for a start without a step. An older release refuses the file afterwards.

Version 4 adds the token and audit tables `api_tokens`, `token_secrets`, `token_bootstrap`, `audit_log` and `audit_pending`. The tokens of the token files are imported at the first start (see [Token import](configuration.md#token-import)). An older release refuses a version-4 file: back up before the upgrade, and restore that backup to go back.

- Upgrades are automatic. Back up the database file first (see [Backup and restore](#backup-and-restore)).
- A file whose `user_version` is higher than the program supports is refused at start with exit code 2 (`database schema version 2 is newer than this program supports (1); downgrades are not supported`). Downgrades are not supported: restore the backup (see [Backup and restore](#backup-and-restore)).

#### Rolling out a new check type

A new check type (tcp, dns, domain) needs every probe location updated first. An old probe logs `skipping invalid check <id>: ...` for a type it does not know, keeps running the other checks, and the new check stays `unknown` for that location. That `unknown` state is expected until the probe is updated. Order: update the contract users (probes, status), then add the check to the checks file.

The table `latency_daily` (daily p50 and p95 per check) is created with `CREATE TABLE IF NOT EXISTS` on every open, so a file from an older release gets it without a numbered step and `user_version` does not change. Back it up with the database file; it can be rebuilt from the results, so restoring a file without it is safe. The background backfill after the next start refills the closed days, and a read fills the days of the checks it returns.

The table `uptime_daily` holds the good and total result counts per check and closed UTC day, the source of the closed days in `GET /uptime`, `GET /components/uptime` and `slo`. It can be rebuilt from the results. Deleting its rows with the API stopped is safe: the backfill and the reads fill them again from `results`. Do not delete rows while the API runs, because it keeps the loaded days in memory.

The table `uptime_location_daily` holds the good and total result counts per check, closed UTC day and location, the source of the closed days in `GET /checks/:id/location-uptime`. It is created with `CREATE TABLE IF NOT EXISTS` on every open, without a numbered step, so `user_version` does not change. A stored day counts as complete when its location totals sum to that day's `uptime_daily` total; otherwise a read or the backfill replaces the day's location rows from `results` in one transaction. So the table can be rebuilt from the results: restoring a file without it, or deleting its rows, is safe. A downgrade without a restore is safe too: an older release ignores the table, and a late result that it stores changes only `uptime_daily`, so that day no longer sums and is rebuilt after the next upgrade.

#### Rolling out latency history and availability objectives

Roll out in this order:

1. Contract release with `CheckLatency`, `Slo` and `availabilityTarget`.
2. Probes: bump their contract pin to `6401721768c1996192c5cdadef7835d852015248` or later. A probe validates every check it receives and skips one with a field its contract does not know.
3. This API. `GET /probe/checks` is built from the stored check columns and never carries `availabilityTarget`, `slo` or any latency field, so an API upgrade does not break a probe that has not been updated. Setting `availabilityTarget` in the checks file is therefore safe before step 2, but the probes do not need the field to measure.
4. The status page: its proxy must allow `/api/latency` before it can draw the chart.

First reads after a restart take about as long as later reads, because the closed days come from `uptime_daily`. Local measurements with 20 checks (`bun bench/cold-read.ts`): with 864,000 results the first `GET /checks` after a restart took 9 ms and the first `GET /uptime` 5 ms; with 8.64 million results 34 ms and 29 ms, and both at once 64 ms. Before `uptime_daily` the same reads took about 210 ms each at 864,000 results and about 2.4 s each at 8.64 million (4.8 s both at once). Once per database, the first start after the upgrade still has that cost: the table is empty, so its first reads compute the closed days from the results and store them (about 1.2 s for `GET /checks` at 864,000 results and 2.5 s at 8.64 million). Today's part is built once per process and UTC day: the first read scans today's results of each check, so its cost grows with the UTC hour. Later reads, also right after an ingest, use the in-memory tally and sorted latencies of today. With 20 checks and 518,400 results of today (one result per 10 s from 3 locations, a full day; `bun bench/eod-read.ts`), each read right after one ingest took at p95: `GET /checks` 3 ms (250 ms before), `GET /uptime` 2 ms (249 ms), `GET /latency` 4 ms (357 ms), `GET /checks/:id/latency` 1 ms (20 ms), `GET /components` 3 ms (493 ms) and `GET /components/uptime` 2 ms (252 ms). Today's latencies take 8 bytes per non-`down` result of today per HTTP check: 4.1 MB at 20 checks x 25,920 results, up to twice that with spare capacity. That run's `VmRSS` was about 98 MiB, against 89 MiB before. The latency backfill of the closed days computes for about 1.7 s in total, as background work after start, spread over many small batches. Later reads come from the cache.

The latency backfill starts 5 s after the API listens, so it is not part of the start. It computes one day of one check per batch and yields to waiting requests after each batch. Only closed days without a row are computed, so a restart on the same day computes nothing. After the first run it repeats hourly. The first run logs two lines, also when it stores nothing:

```text
latency rollup: backfill started (20 checks)
latency rollup: backfill done, stored 1780 days in 2412 ms
```

An hourly run logs `latency rollup: stored <N> days in <D> ms` only when it stored days. A failed run logs `latency rollup failed: <message>` at `warn`; the other lines are `info`. A shutdown waits for the batch in progress before it closes the database.

The uptime backfill fills `uptime_daily` the same way. It starts 5 s after the API listens, stores one closed day of one active check per batch, yields to waiting requests after each batch, and repeats hourly (that run stores yesterday after midnight, unless a read did it first). `/readyz` does not wait for it: a read finds the closed days still without a row, computes them from the results and stores them, so routes answer correctly and the same before, during and after the backfill. The first run logs two lines, also when it stores nothing:

```text
uptime rollup: backfill started (20 checks)
uptime rollup: backfill done, stored 0 days and 0 location days in 2 ms
```

After the uptime days, the same run rebuilds the location tallies (`uptime_location_daily`) of every closed day whose location totals do not sum to its `uptime_daily` total, one (check, day) per batch with a yield after each. An hourly run logs `uptime rollup: stored <N> days and <L> location days in <D> ms` only when it stored days or location days. A failed run logs `uptime rollup failed: <message>` at `warn`; the other lines are `info`. A shutdown waits for the batch in progress before it closes the database.

### Upgrades

1. Back up the database file with `bun run backup` (see [Backup and restore](#backup-and-restore)). It is the only way back to an older release.
2. Stop the API and start the new version with the same `PULSE_DB`.
3. Look at the start log line to see that it came up (see [Logs](#logs)).

Upgrade to the version that binds header secrets to hosts: prepare before the API starts, or the checks file fails to load.

- Rename every `env` reference to `PULSE_HEADER_*`.
- Remove userinfo from check URLs; move credentials to an `Authorization` header with `{ "env": NAME }`.
- Set TLS and domain `warnDays` to 0..3650.
- Set `PULSE_PROBE_HEADER_HOSTS` at every probe location (older probes ignore it).

Served results now carry integer `latencyMs` (stored fractions are rounded) and a `reason` of at most 1000 characters (longer stored ones end in `…`). Stored rows are not rewritten.

Downgrades are not supported: an older release refuses a database file with a higher schema version (exit 2, `downgrades are not supported`). The version with database checks adds schema step 6 (`SCHEMA_VERSION` 6); back up before the upgrade, because database checks exist only in the database and a release before it cannot read them. To go back, restore the backup; database checks created after the backup are lost. Going back without restoring the backup works only to a release with the same `SCHEMA_VERSION`; otherwise restore the backup (see [Backup and restore](#backup-and-restore)).

#### Upgrade to 32-character admin secrets

This version accepts an admin-side secret (any token without the `probe` scope) only with 32 or more characters. A shorter one fails the import, and a shorter stored one answers `401` at every admin route. Probe tokens keep the 16-character minimum. This version adds no schema step: `SCHEMA_VERSION` stays 5. The path depends on the version you run now.

From `v0.1.0` (tokens read from files, schema version 3):

- Before: on `v0.1.0`, give every entry of the admin tokens file a token of 32 or more characters by file rotation (add the new one, restart, remove the old one, restart). Then back up the database with `bun run backup`.
- If the start fails or no admin token works: a start that fails with exit 2 and `at least 32 characters` imported nothing, but it already migrated the file to schema version 5. Fix the admin tokens file and start this version again; the import is still pending, so it reads the file again.
- Going back: `v0.1.0` refuses the migrated file with exit 2 (`downgrades are not supported`). Restore the backup to run `v0.1.0` again.

From a build with the token store (schema version 5):

- Before: on that build, rotate every admin-side token with `source` `file` whose secret is shorter than 32 characters with `POST /admin/tokens/<id>/rotate` (see [Token rotation](#token-rotation)). Give clients the new 49-character secret within the 10-minute overlap. Editing the imported admin tokens file changes nothing.
- If no admin token works: after the upgrade a short secret answers `401`, also during a rotation overlap. Run the previous build again (same schema version 5, no step to undo), rotate there, and upgrade again.
- Going back: without a backup only to a build with the same `SCHEMA_VERSION` (5). Restoring the backup also works.

A checks file whose heartbeat `secret` still starts with `replace-with-` (the example placeholder) stops the start with `checks[<i>].secret still has the example placeholder secret` and exit code 2. Replace the secret with `openssl rand -hex 32` and update the job that pings, or remove the check. An API that is already running rejects such a reload and keeps its config.

### Backup and restore

`bun run backup <file>` writes a consistent copy of the database at `PULSE_DB` to `<file>`. It works while the API serves traffic: it copies one snapshot on its own read-only connection and never blocks the API's writes. With Compose:

```sh
docker compose exec api bun run backup /data/backup-2026-10-31.db
docker compose cp api:/data/backup-2026-10-31.db ./
```

On success it prints one line with the numbers of the copy (not of the live file, which may have moved on):

```text
backup /data/backup-2026-10-31.db: schema version 2, checks 12, results 340512, incidents 7
```

- Exit code `0`: the backup is written. `2`: a wrong number of arguments, an empty argument, or a target that exists. `1`: any other error (missing source, missing target directory, copy, write or report failure). An error is one line `pulse-api backup: <message>` on stderr, with the paths and the SQLite message.
- It never overwrites a file: a target that exists, also a symlink, is refused. The target's directory must exist; it is not created. The copy is written with `VACUUM INTO` to `backup.db` in a new temp directory `.<name>.tmp-XXXXXX` (random suffix, mode `0700`) in the same directory, then linked to the target name, so the target is never partial. The temp directory is removed at the end. A failed run removes it too. So does a run stopped with `SIGINT` (Ctrl+C), `SIGTERM` or `SIGHUP`: it exits 1 with `interrupted; no backup written and the temp directory is removed`. A signal during the copy is handled when the copy step ends, before the publish. A signal that arrives after that does not stop the publish, and the run exits 0. A run ended by `SIGKILL`, a crash or a power loss can leave `.<name>.tmp-XXXXXX` behind, with a full copy of the database (mode `0600`) inside. Plain `ls` does not show it; find it with `ls -a` and delete it. The command never removes a file or directory that it did not create. The copy has mode `0600` (owner only); use `chmod` if another user must read it. On a file system without hard links it renames the copy after a second check; another process that creates the target between that check and the rename would lose its file.
- No other user can create, read or replace a file in the temp directory. The run works inside it by relative names, so another user who renames the temp directory in a shared directory gets no data and cannot change what is published. One narrow race is left: SQLite opens the copy by its full path, so a user who can write to the target's directory and swaps the temp directory's name at that moment could get the copy written into a file of theirs. Write backups to a directory that only the API user can write to (`/data` in the image is one).
- It needs free space for one copy of the live data in the target's file system. Memory use does not grow with the database: SQLite copies page by page (in a local measurement of a 131 MiB file with 16 MiB of live data: at most 45 MiB peak RSS, of which about 33 MiB is the Bun process itself; the copy was 16 MiB).
- The copy is a `VACUUM INTO` copy: it holds the live data only, without free pages, so deleted rows are not in it and it can be much smaller than the live file. It is in rollback-journal mode; the API switches it to WAL when it opens it. The report line reads its numbers from the published copy.
- It opens the source read-only and never migrates or changes it; any schema version is accepted. A missing source is an error and is not created.
- It also works with the API stopped. Then SQLite creates `pulse.db-wal` and `pulse.db-shm` and leaves them, so the source directory must be writable. Run it as the image's default user (no `docker compose exec -u root`), or those files can end up owned by root.
- While the backup reads, a checkpoint cannot move past its snapshot, so `pulse.db-wal` grows for the length of the backup. A later checkpoint resets it.

A cold copy (`cp pulse.db`) is safe only after a clean stop, when no `pulse.db-wal` is left. After a crash or `SIGKILL` the last transactions can still be in `pulse.db-wal`: use the backup command, or copy `pulse.db-wal` together with the file.

To restore:

1. Stop the API.
2. Replace `pulse.db` at `PULSE_DB` with the backup file.
3. Delete `pulse.db-wal` and `pulse.db-shm` if they exist. A stale WAL belongs to the old file and must not be applied to the restored one.
4. Start the API.

A file under `/data` sits on the live volume: when the volume or the host is lost, the backup is lost with it. Move each copy to storage outside that volume and that host (the `docker compose cp` step above, then off the host), keep more than one copy, and test a restore from time to time.

A backup from an older version is migrated at start. A file with a newer schema version is refused with exit code 2 (see [Schema](#schema)). With Compose the file is in the `api-data` volume.

## Retention and disk space

Cleanup of old results runs at start and then hourly. See [Retention](concepts.md#retention) for the rules. Set the number of days with `PULSE_RETENTION_DAYS`. The latency rollups (`latency_daily`, one small row per HTTP check and day) are deleted with the same cutoff, which is never inside the 90-day window, and when their check is gone. The uptime tallies (`uptime_daily`, one small row per check and closed day) and the location tallies (`uptime_location_daily`, one small row per check, closed day and location) follow the same rules: the same cutoff, and deleted when their check is gone. A check removed from the configuration stays in the database, so its rows stay. Resend commands, in any state, and resend request ids are deleted 7 days (604 800 000 ms) after their own creation, independent of `PULSE_RETENTION_DAYS`. At most 1000 commands and 10 000 request ids are kept; a full table answers `503` with `retry-after: 60` (see [Resend](rest-api.md#resend)).

Rows per check per day are `86400 / interval_s * locations`. A row takes roughly 100 bytes with its indexes in a measured database of minimal rows (129,600 rows, 60 s interval, about 13 MB). Allow about 250 bytes for rows with reasons. Example: 60 s interval, 1 location and 90 days give 129,600 rows, roughly 30 MB per check.

The file does not shrink after deletes. SQLite reuses the freed pages. To reclaim the space, run `VACUUM` with the API stopped:

```sh
sqlite3 /path/to/pulse.db 'VACUUM'
```

This command was not run for this page; it needs the `sqlite3` tool.

## Manual incidents

Enable them with the first import of `PULSE_API_ADMIN_TOKENS_FILE` (see [Configuration](configuration.md#token-import)); the `curl` examples are in [REST API](rest-api.md#write-routes). Counters: `pulse_api_manual_incidents_created_total` and `pulse_api_manual_incidents_resolved_total`, without labels. The start log says `manualIncidents` is `writable` or `off` and counts `adminTokens`. While it is `off`, the reads are empty even when the database holds incidents. The tables are created on start in an older database; nothing else changes. Rotate admin tokens over HTTP (see [Token rotation](#token-rotation)). Every write logs `manual incident write` (with the admin token name) or `manual incident write failed`, and every failed authentication logs `admin auth failed` (see [Logs](#logs)).

Drafts, internal-only incidents and notes are managed under `/admin/manual-incidents` (see [REST API](rest-api.md#private-routes)). The counters count only `public` incidents: a public publication (legacy create or publish of a public draft) and a public resolution. Drafts, internal incidents, notes and their edits count nothing, and requests to `/admin/manual-incidents*` are not in `pulse_api_http_requests_total`; their failed authentications are in `pulse_api_admin_auth_failures_total`. Watch that activity in the audit log and the log lines. Internal incidents are never notified. A draft incident does not block a component delete; a published open incident (public or internal) does, and the refusal raises `pulse_api_config_writes_total{result="conflict"}` (known limit: the label does not say which incident blocked it).

Upgrade order: any order is safe for drafts and internal incidents, because the api alone keeps them private; status and notify only add a second filter. The usual order stays contract, then status and notify, then api. Status and notify treat a `404` from `/manual-incidents` of an older api as no incidents. The first start migrates the database to schema version 7. An older api refuses that file, so make a backup with `bun run backup <file>` before the upgrade: a downgrade needs it.

## Token rotation

Tokens are managed over HTTP with a token that has `admin` (see [Tokens](rest-api.md#tokens)); no restart of the API is needed. To rotate a probe token:

1. `POST /admin/tokens/<id>/rotate`. The answer holds the new `secret`. The old secret stays valid for 10 minutes (`previousValidUntil`).
2. Within those 10 minutes, give the probe the new secret as `PULSE_PROBE_TOKEN` (in pulse-deploy: `secrets/probe-token`) and restart the probe. The probe reads its token only at start.
3. After the overlap only the new secret works. To end it at once, revoke the token and create a new one instead.

A client with an `admin` token can confirm which token it holds with `GET /admin/tokens/self` (`curl -sS "$API/admin/tokens/self" -H "Authorization: Bearer $TOKEN"`). It answers that token's metadata, never a secret; during an overlap the old and the new secret answer the same `id`.

A new location gets its own token: `POST /admin/tokens` with `{"name":"probe eu","scopes":["probe"],"location":"eu"}`. Changing a probe's location means a new token for the new location; the probe's `PULSE_LOCATION` and the token's `location` must be equal, or every result gets `403`.

An admin-side secret (a token without the `probe` scope) must have 32 or more characters, also an imported one; a shorter one answers `401`. Imported probe tokens keep the secret from the old file with at least 16 characters. Rotate imported tokens once, so every secret in use is a generated 256-bit one.

**Lockout.** Revoking the last active admin token is refused, but expiry can still leave no admin. There is no recovery command: restore a [backup](#backup-and-restore) taken while an admin token was active. Keep at least one admin token without `expiresAt`.

## Audit log

Every admin write adds one entry; read them with `GET /admin/audit` or `GET /admin/audit/export` (see [Audit log](rest-api.md#audit-log)). The table only grows: retention never deletes entries, and there is no delete route. An entry is about 150 bytes, so even 1000 writes a day add only about 55 MB a year.

### Audit durability

A config write stores its entry as pending, durably, before it renames the checks file, and confirms it after the rename is on disk. A pending entry left by a crash or a failed step is resolved at the next config write or start: if the write's temp file is gone, the rename happened and the entry is kept; if the temp file is still there, the write did not happen, and the entry and the file are dropped. So, for a process crash or a power loss at any point:

- an acknowledged config write always has an entry;
- a write whose rename is on disk after the restart gets its entry, at the latest at the next write or start;
- a write whose rename is not on disk never gets an entry.

This holds on a local file system where `fsync` of a file and its directory persists what it reports and `rename` is atomic (ext4, xfs, btrfs), in WAL mode and in the rollback-journal fallback: the durable statements run at `synchronous = EXTRA`. It does not hold on a disk or network file system that acknowledges `fsync` without persisting.

A leftover `<checks>.<suffix>.tmp` file next to the checks file without a pending entry (after a crash, or when its removal failed) is never read and does not change the audit. Delete it while the API is stopped.

Manual-incident and token writes commit with their entry in one transaction.

## Admin tokens and header secrets

A token with the scopes `admin` and `checks` can point any check that references `{ "env": NAME }` at another URL. The probe sends the secret to that URL only when its `PULSE_PROBE_HEADER_HOSTS` binds `NAME` to that host. So such a token is as sensitive as every secret that is bound to a host, and the probe's `PULSE_PROBE_HEADER_HOSTS` is the limit. Keeping the secret only in the probe's environment does not remove that authority. Bind each secret only to the hosts that need it.

A probe token reads the literal header values and request bodies of every check from `GET /probe/checks`. It does not read the values of `{ "env": NAME }` references: the API never has them.

Do not put credentials in a check URL. A URL with userinfo (`user:password@`) is rejected, but a token in the query string or the path is accepted and stored. The URL is served unchanged by the public `GET /checks`, by `GET /probe/checks` and by `GET /admin/config`. The status page removes userinfo, query and fragment from what it shows, but that does not protect a direct read of the API. Put the credential in a header with `{ "env": NAME }` and bind it to its host (see [HTTP checks](configuration.md#http-checks)).

## Changing checks

Checks come from two sources: the checks file and the database. Change the file by hand; the API applies it without a restart. Create, replace and delete database checks through the [admin routes](rest-api.md#admin-config-routes). Components live only in the file; an admin write of them rewrites the file. Maintenance windows come from the file and from the database: an admin window write stores a database window and never touches the file, so it also works with a broken, unreadable or read-only file. File windows are read-only through the admin API.

**Effective set.** The API runs the checks of the applied file, in file order, then the database checks whose id the file does not hold, in creation order. A file check wins over a database check with the same id: the database copy is _shadowed_. It is listed under `shadowed` in `GET /admin/config`, can only be deleted, and becomes effective again when the file no longer holds the id. Components may reference only file checks; a reference to a database-only check answers `422`. A database window may name file and database checks that are in effect at write time. A check that leaves later does not block the reload or the delete: the window keeps the id and skips it until the check is back. A file window with the same `id` as a database window wins over the whole database window, which is listed under `shadowed` in `GET /admin/maintenance` and can only be deleted.

**Hot reload.** The API looks at the file every `PULSE_CHECKS_RELOAD_INTERVAL_MS` (default 5000; `0` turns it off). One look is one `stat`. Only when the modification time, size or inode changed does it read and hash the file; the same bytes (a `touch`) change nothing. It does not use `fs.watch`; the look sees a replaced file by its inode. A rename over a single-file bind mount does not reach the container (it keeps the old inode), so mount the directory that holds the file. An edit that keeps mtime, size and inode is not seen by the look: send `SIGHUP`, which always reads, hashes and applies the file.

```sh
kill -HUP "$(pidof bun)"                  # on the host
docker compose kill -s HUP api            # with Compose
```

A valid file is applied in one step: checks are upserted, components, maintenance windows and heartbeat secrets are replaced, and the read cache is cleared. A changed check field reaches a probe at its next fetch of `GET /probe/checks`. State of an unchanged heartbeat check is kept, and a changed secret works for the next ping. Existing manual incidents that name a removed component stay readable and can be resolved; a new one for it is refused. Maintenance windows that are active at the reload end at their own times; a removed window ends at once.

An invalid or unreadable file is not applied. The API keeps the running configuration, logs a `warn` line, `config reload rejected: <path>: <message>` (the message never quotes a value), and counts `pulse_api_config_reload_total{result="invalid"}`. Polling and `SIGHUP` share one memory of the last warning line: a rejection whose line equals it is not logged or counted again, even when the file's bytes change. A rejection with another message is logged and counted. A successful apply clears the memory, so the same rejection is logged and counted again after it. `SIGHUP` reads and validates the file at once but does not clear the memory. An unreadable file is read again at every look, so fixing its permissions applies it without a `SIGHUP`. Database check writes still work while the file is broken.

**File state.** `GET /admin/config` reports `file`: `state` is `ok`, `invalid` (the last read did not parse or validate), `unreadable` (the last read failed) or `written-not-applied` (a valid file could not be applied); `message` is `null` for `ok`, else the safe text of the warn line without the path; `lastAppliedAt` is the epoch ms of the last file apply. A database write does not change `lastAppliedAt`.

**Start with a broken file.** Every applied file is stored in the database as a snapshot (heartbeat secrets only as SHA-256 digests). When the file is invalid or missing at start and a snapshot exists, the API starts from the snapshot, serves its checks, components and windows, accepts file heartbeat pings, reports the file state and logs one `warn` line `config load rejected at start: <message>; using the checks file applied at <ISO time>`. Without a snapshot (a fresh database) an invalid or missing file still stops the start with exit code 2. The database is opened before the file is read.

A valid file that cannot be applied (for example a database error) is not applied either. The API keeps the running configuration and revision, logs one `warn` line, `config reload failed: <path>: cannot apply the configuration: <error>`, and counts `pulse_api_config_reload_total{result="error"}`. `<error>` is only the error name and code (for example `Error SQLITE_BUSY`), never its message. The file is applied again at every look, but a lasting failure logs the warn line only once.

Checks that leave the configuration (removed from the file, or a database check deleted) stay in the database with their results, but become inactive. The API does not delete checks. An inactive check is left out of `GET /checks` and `GET /uptime`, and `POST /results` for it answers `404 unknown check`. Its results and incidents stay readable. At the reload an open incident of a removed check is resolved (`resolvedAt` is the reload time, one log line per incident) and the check state is reset, so `notify` may send a "resolved" notification. If you add the check again, it becomes active with its history.

**Writing through the API.** Use a token with `admin` and `checks` (the first one comes from the import of `PULSE_API_ADMIN_TOKENS_FILE`). Every write needs `If-Match` with the `ETag` of the last read:

```sh
API=http://127.0.0.1:3000
TOKEN=$(cat /path/to/admin-token)
ETAG=$(curl -sS -D - -o /dev/null "$API/admin/config" -H "Authorization: Bearer $TOKEN" | tr -d '\r' | sed -n 's/^[Ee][Tt]ag: //p')
curl -sS -X POST "$API/admin/checks" -H "Authorization: Bearer $TOKEN" -H "If-Match: $ETAG" \
  -H 'Content-Type: application/json' \
  -d '{"id":"blog","name":"Blog","url":"https://blog.example/","intervalMs":60000}'
```

A database check is stored in the database, in one transaction with its audit entry; it needs no writable checks file. Each committed check write raises the database generation by one, so send the `ETag` of the last answer, or read `GET /admin/config` again, with every write.

**Edit a database check (GET-edit-PUT).** The view of a check never holds literal header values or bodies: each one is shown as `{"keep": true}`, and `{"env": NAME}` references are shown as they are. Send the view back with `PUT`, and every marker keeps the stored value. A header or body you leave out is removed. A heartbeat `PUT` without `secret` keeps the stored secret; a new `secret` replaces it.

```sh
VIEW=$(curl -sS -D /tmp/h "$API/admin/config" -H "Authorization: Bearer $TOKEN" | jq '.checks[] | select(.id == "blog")')
ETAG=$(tr -d '\r' < /tmp/h | sed -n 's/^[Ee][Tt]ag: //p')
echo "$VIEW" | jq '.name = "Blog (new name)"' |
  curl -sS -X PUT "$API/admin/checks/blog" -H "Authorization: Bearer $TOKEN" -H "If-Match: $ETAG" \
    -H 'Content-Type: application/json' --data-binary @-
```

A file check (`source: "file"`) answers `409` to `PUT` and `DELETE`: edit the file.

A component write needs a checks file that the API can replace: it writes a temp file in the same directory and renames it over the file. A read-only mount, or a single file bind-mounted into the container, answers `503` (for example `checks file is read-only (EROFS)`). The `full` setup of [pulse-deploy](https://github.com/lorenzh/pulse-deploy) mounts its `full/config` directory read-only, so a hand edit, also a save by rename, reaches the container. To opt in to writes, mount that directory writable instead, with a directory that the container user may write. The file keeps its mode and, when the process may set it, its owner. The write rewrites the file as JSON with two spaces: comments and layout of a hand-made file are not kept. A hand edit and a write at the same moment can still race in the last millisecond before the rename; the revision check makes this rare, not impossible. A write runs in this order: temp file, `fsync`, revision check, rename, `fsync` of the directory, then apply. When a step after the rename fails (the directory `fsync`, or applying to the database), the write answers `500` (`503` for a read-only cause), but the new file is already in place. The running configuration and the `ETag` stay at the old revision, and the next reload (a look or `SIGHUP`) applies the file. Until then a component write gets `412`. Such a write also needs the file on disk to be the applied one: when it differs (a broken or not yet applied hand edit), the answer is `412` `the checks file on disk differs from the applied one (<state>): fix or reload it, then retry`. A file write never changes database checks or windows. Database check writes never answer `503`, and window writes never do either.

Each successful write logs one `info` line `config write` with the token name, kind, action and id; a failed write logs one `warn` line with the status and kind. Metrics: `pulse_api_config_writes_total{kind,action,result}`.

### Export the checks

`GET /admin/config/export` returns the effective checks with the file's components and the effective windows as one checks file (see [GET /admin/config/export](rest-api.md#get-adminconfigexport)). Literal header values, bodies and heartbeat secrets are left out and listed in `redacted`. Such an export cannot be loaded as a checks file until you put the listed values back (new heartbeat secrets) and remove `redacted`. To move database checks into the file:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/admin/config/export > export.json
jq '.redacted' export.json   # the values to fill in by hand
```

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

- `listening` (info): The API is ready. Fields: `port`, `checks`, `maintenanceWindows` (windows of the file), `databaseMaintenanceWindows` (stored database windows, shadowed included), `checksFile`, `db`, `fileState` (the file state at start), `databaseChecks` (the number of stored database checks), `retentionDays`, `probeTokens` and `locations` (active probe tokens in the database), `adminTokens` (active admin-side tokens), `tokensFile`, `tokenStore` (`database`).
- `retention: deleted <n> results` (info): A cleanup deleted rows (results, resolved manual incidents, resend commands and resend request ids). Silent when it deletes none.
- `retention failed: <message>` (warn): A cleanup failed. The next run is still scheduled.
- `config load rejected at start: <message>; using the checks file applied at <ISO time>` (warn): The checks file was invalid or unreadable at start, and the stored snapshot is used. The message has no path and no values.
- `check "<id>" removed from the configuration: incident resolved` (info): One line per incident resolved when its check leaves the configuration.
- `request failed` (error): Once per unexpected failure in a request. Before the response headers the client gets `500`; after them the started response is closed. The field `error` holds the stack.
- `shutdown bound reached: closing open connections` (warn): The shutdown took longer than 5 s.
- `stopped` (info): The shutdown is done.
- `startup failed` (error): An unexpected failure at start. The process exits with code 1.
- `shutting down` (info): A signal arrived. Field: `signal`.
- `admin auth failed` (warn): A request to `/admin/*` or a manual-incident write had no valid admin token (`401` or `403`). Fields: `route` (the route pattern, such as `/admin/checks/:id`), `status`, `token` (`missing` without a Bearer header, `unknown` for an unknown token, `inactive` for an expired, revoked or rotated-out one, `probe` for a probe token, `short` for an admin-side secret shorter than 32 characters, `scope` for a token without the needed scope) and `suppressed`. One line per route, status and kind per minute; `suppressed` counts the failures of that key dropped since its previous line. A dropped count shows only in the next line of the same key; with no later failure it is only in `pulse_api_admin_auth_failures_total`, which counts every failure.
- `admin auth throttled` (warn): The auth throttle answered `429`. Fields: `route` (the route pattern) and `suppressed` (the `429`s of that route not logged since its previous line). At most one line per route per minute. No client address or token data. See [Admin auth throttle](#admin-auth-throttle).
- `manual incident write` (info): A manual-incident write succeeded. Fields: `token` (the admin token name), `action` (`create`, `update`, `resolve`, `delete`; the private routes add `create-draft`, `edit`, `save-draft`, `discard-draft`, `publish`, `add-note`, `delete-note`) and `id`.
- `token write` (info): A token was created, rotated or revoked. Fields: `token` (the caller's name), `action` and `id` (the target token id). Never the secret or the target's name.
- `<setting> ignored: tokens are stored in the database` (info): A token file setting is set after its import.
- `audit pending entry kept (<code>)`, `audit pending entry unresolved (<code>)`, `config temp file not removed (<code>)` (warn): A step of the [audit durability](#audit-durability) protocol failed. Only the error code, never a path.
- `manual incident write failed` (warn): A manual-incident write failed after authentication (`400`, `404`, `409`, `413`). Fields: `status`, `action` and, except for `create` and `create-draft`, `id`. Private reads are not logged.

A log field named `time`, `level` or `msg` does not replace the base key.

A configuration or startup error is not a JSON line: it is one line `pulse-api: <message>` on stderr with exit code 2. See [Exit codes](configuration.md#exit-codes).

The log never prints token values, heartbeat secrets, header values or request bodies. Token **names** and ids do appear; secrets and digests never do.

With Compose: `docker compose logs api`.

## Probe locations

`GET /locations` lists each probe location with `reporting` or `silent` ([REST API](rest-api.md#get-locations)); the silent threshold is `PULSE_LOCATION_SILENT_MS` ([Configuration](configuration.md)). The metric `pulse_api_location_last_result_timestamp_seconds{location}` is the newest accepted result timestamp. Alert on silence, for example `time() - pulse_api_location_last_result_timestamp_seconds > 300`. The metric uses the result timestamp, so after a long outage it lags until a probe has delivered its buffered results; `GET /locations` uses the receive time and is `reporting` as soon as the probe delivers.

A probe that could not reach the API keeps its results in a bounded buffer and re-sends them in order. `POST /results` is idempotent, so a re-sent result that the API already stored is safe. Replayed results are processed like live ones with their original timestamps (they are not late unless they arrive out of order), so a replay can open or resolve an incident with an old time and notify can send late notifications after an outage. The API rejects results older than 7 days. The probe keeps that buffer in memory, so a restart or stop of a probe loses its unsent results (see the probe's [Result buffer](https://github.com/lorenzh/pulse-probe/blob/main/docs/operation.md#result-buffer)).

## Health and metrics

`GET /healthz` is liveness: `200 ok`, no database access, also while the API shuts down (it used to answer `503` then). `GET /readyz` is readiness: `200 ok` when `SELECT 1` works and the API is not shutting down, else `503` with a short text and no database error. The image `HEALTHCHECK` and every gate on the API use `/readyz`. `GET /metrics` returns Prometheus text (content type `text/plain; version=0.0.4; charset=utf-8`, with `# HELP` lines). A wrong method on these three paths (also `HEAD`) answers `405` with the JSON body `{"error":"method not allowed"}` and the header `Allow: GET`. Every other API route also sends `Allow` with its methods on a `405`. None needs a token. See [GET /healthz](rest-api.md#get-healthz) and [GET /metrics](rest-api.md#get-metrics). `/metrics` lists check ids: keep it on a private network. `pulse_api_admin_auth_throttled_total{route}` counts admin requests refused with `429` by the [admin auth throttle](#admin-auth-throttle); alert with `increase(pulse_api_admin_auth_throttled_total[5m]) > 0`.

### Admin auth throttle

The API throttles failed admin authentications per client: 10 failures per 60 s window from the first failure, then `429` with `Retry-After` until the window ends (see [REST API](rest-api.md#admin-auth-throttle)). The limits are fixed; there is no setting.

- The state is per process and resets on restart. Several API processes each keep their own budget.
- The client is the peer address (IPv4, or the IPv6 `/64`); forwarding headers are ignored. Clients behind one NAT or reverse proxy share one budget, so a broken script there can block a person for up to 60 s.
- At most 10 000 clients have their own window. A client without its own live window shares one overflow budget (10 failures per overflow window) while the table is full **or** the overflow window is live. This also holds for a client whose own window just ended. It gets its own window again only after the overflow window has ended and a slot is free. An attacker with more than 10 000 addresses or `/64` prefixes in one minute can use up the overflow budget; then such clients get `429` for up to 60 s. Clients with a live own window and the public routes are not affected. Recovery: wait for the overflow window to end, or restart the API.
- Bound: at most 10 evaluated failures per window and at most 10 001 live windows. Fixed windows can follow each other directly, so in any 60 000 ms one process evaluates at most `2 × (10 000 + 1) × 10 = 200 020` admin auth failures (factor 2), not 100 010. This bound holds while the system clock does not go backwards. A backward clock step (a manual change or an NTP step) after windows ended can let more failures through in that 60 000 ms; the per-client limit and the `429` answer still apply.
- Alert on throttling with `increase(pulse_api_admin_auth_throttled_total[5m]) > 0`.

## Shutdown

`SIGINT` and `SIGTERM` are handled from the first line of the process. The API then answers `/readyz` with `503`, stops accepting connections, closes idle ones, stops the retention timer (no run starts after that), waits for open requests and for the cleanup run in progress, closes the database and exits with code 0. The wait is bounded by 5 s inside the API, with a 1 s backstop in `pulse-kit`'s `runService`. When the bound is hit, the cleanup is told to stop after its current batch (a batch is synchronous) and the database closes only after it ended; then the API logs a `warn` line, drops the remaining connections, closes the database and exits with code 1. A clean stop exits 0. A second signal changes nothing. `docker stop` therefore returns well within its default 10 s.
