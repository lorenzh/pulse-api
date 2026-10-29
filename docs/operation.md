# Operation

## Start and restart

The API reads `checks.json`, the tokens file and its environment once at start. It has no reload. Restart it after any change to these.

When you run the whole stack, restart in this order: the API first, then the probes. Probes read their checks from the API once at start.

```sh
docker compose up -d
docker compose restart probe
```

Everything else is kept in the database, so a restart loses no state. The check counter and open incidents survive restarts.

## Database

The database is one SQLite file, at `PULSE_DB` (default `./pulse.db`, `/data/pulse.db` in the Docker image). The API does not set a journal mode, so SQLite uses its default (a rollback journal). In a run of the API with the example files, the directory held only `pulse.db`; there were no `-wal` or `-shm` files. A short-lived `pulse.db-journal` file can exist while a write runs.

### Schema migrations

The schema is created at start (`CREATE TABLE IF NOT EXISTS`). Then `src/db.ts` checks the columns of `results` and `checks` and adds the ones that are missing (`location`, `cert_days_left`, `attempts` and the check columns for TLS and retries), and creates the indexes `results_by_location` and `results_by_time`. Old rows get the defaults (`location` is `default`, `attempts` is 1). There is no separate migration command, and no down migration.

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

Edit `checks.json`, restart the API, then restart the probes. The file is upserted: checks that you remove from the file stay in the database with their old state and results. The API does not delete checks.

## Logs

The API writes to stdout and stderr. It has no log levels and no log file.

| Line                                                                                                                                                              | When                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pulse-api listening on :<port> (<n> checks, <n> maintenance windows from <file>, db <path>, retention <n> days; <n> probe tokens for <n> locations from <file>)` | The API is ready.                                                        |
| `retention: deleted <n> results`                                                                                                                                  | A cleanup deleted rows. Silent when it deletes none.                     |
| `retention failed: <message>`                                                                                                                                     | A cleanup failed. The next run is still scheduled.                       |
| `pulse-api: <message>`                                                                                                                                            | The tokens file is invalid. Exit code 1.                                 |
| An error stack that starts with `ConfigError` or `RetentionConfigError`                                                                                           | The checks file or `PULSE_RETENTION_DAYS` is invalid. The process exits. |
| An error stack on stderr                                                                                                                                          | An unexpected failure in a request (`500`).                              |

The log never prints token values.

With Compose: `docker compose logs api`.
