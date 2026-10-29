# Configuration

The API is configured by environment variables and two JSON files. It reads all of them once at start. Restart the API to apply a change.

## Environment variables

| Variable               | Default         | Meaning                                                      |
| ---------------------- | --------------- | ------------------------------------------------------------ |
| `PORT`                 | `3000`          | HTTP port.                                                   |
| `PULSE_DB`             | `./pulse.db`    | Path of the SQLite file. It is created if it does not exist. |
| `PULSE_CHECKS_FILE`    | `./checks.json` | Path of the [checks file](#checksjson).                      |
| `PULSE_TOKENS_FILE`    | `./tokens.json` | Path of the [tokens file](#tokensjson).                      |
| `PULSE_RETENTION_DAYS` | `90`            | Days of raw results to keep. An integer of at least 90.      |

The Docker image sets `NODE_ENV=production` and `PULSE_DB=/data/pulse.db`.

`PULSE_RETENTION_DAYS` that is not an integer of at least 90 stops the start with `PULSE_RETENTION_DAYS must be an integer >= 90, got "<value>"`. An unset or empty value means 90. See [Retention](concepts.md#retention).

Example:

```sh
PORT=3100 PULSE_DB=/var/lib/pulse/pulse.db PULSE_CHECKS_FILE=/etc/pulse/checks.json \
  PULSE_TOKENS_FILE=/etc/pulse/tokens.json PULSE_RETENTION_DAYS=180 npm start
```

## checks.json

The file is `{"checks": [...], "maintenance": [...]}`. `maintenance` is optional. The checks are validated and upserted into the database at start. Existing state and results are kept. An invalid or unreadable file stops the start with an `Error` that names the problem. Probes read the same checks from `GET /checks`.

See `checks.example.json` for a complete example.

### Fields of every check

| Field        | Required | Meaning                                                                              |
| ------------ | -------- | ------------------------------------------------------------------------------------ |
| `id`         | yes      | Non-empty string, unique in the file.                                                |
| `name`       | yes      | Non-empty string.                                                                    |
| `type`       | no       | `"http"` (default) or `"tls"`. Any other value is rejected.                          |
| `intervalMs` | yes      | Positive integer, milliseconds between probes.                                       |
| `timeoutMs`  | no       | Positive integer, milliseconds. When omitted, the probe uses its own default (5000). |

### HTTP checks

An HTTP check has `type` absent or `"http"` and these fields besides the common ones:

| Field                | Required | Meaning                                                                                                                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                | yes      | `http` or `https` URL to probe.                                                                                                                                         |
| `retries`            | no       | Integer 0 to 10, default 0. Extra attempts the probe makes after a failed one before it reports `down`.                                                                 |
| `retryDelayMs`       | no       | Integer 0 to 60000, default 1000. Wait between attempts.                                                                                                                |
| `latencyObjectiveMs` | no       | Positive integer, milliseconds. A successful (2xx) result slower than this is `degraded`. Absent means no objective.                                                    |
| `keyword`            | no       | Non-empty string, case-sensitive substring. A 2xx answer whose body does not contain it is `down` with the reason `keyword "<text>" not found`. Rejected on TLS checks. |

Notes:

- The probe looks for the keyword within the first 1 MiB (1,048,576 bytes) of the body. Reading the body counts towards the latency.
- When a check is removed from the checks file, its `keyword` is cleared at the next start. The check and its results stay.
- An objective at or above `timeoutMs` can never be degraded.
- `GET /checks` always serves the resolved `retries` and `retryDelayMs`.
- When `retries` is above 0, the file is rejected unless the worst case `(retries + 1) * timeoutMs + retries * retryDelayMs` fits within `intervalMs`. `timeoutMs` defaults to 5000 in this formula.
- Results carry `attempts`, the number of attempts made (at least 1).

### TLS checks

A TLS check (`"type": "tls"`) watches the expiry of the leaf certificate of a server. It takes no `url`.

| Field      | Required | Meaning                                                                                |
| ---------- | -------- | -------------------------------------------------------------------------------------- |
| `host`     | yes      | Host name or IP without scheme, port or path.                                          |
| `port`     | no       | Integer 1 to 65535, default 443.                                                       |
| `warnDays` | no       | Positive integer, default 14. The check is down when this many days or fewer are left. |

Only the expiry of the leaf certificate is judged. The chain and the host name are not verified. Results carry `certDaysLeft`. `GET /checks` shows the latest value and `GET /checks/:id/results` includes it. A TLS check ignores `retries`, `retryDelayMs` and `latencyObjectiveMs`.

### maintenance

`maintenance` is an array of windows. A missing key means no windows.

| Field     | Required | Meaning                                                               |
| --------- | -------- | --------------------------------------------------------------------- |
| `checkId` | yes      | Id of a configured check.                                             |
| `start`   | yes      | ISO 8601 string with an explicit offset (`Z` or `±hh:mm`), inclusive. |
| `end`     | yes      | Same format, exclusive, must be after `start`.                        |
| `note`    | yes      | Non-empty string shown with the maintenance state.                    |

Windows are read at start only. See [Maintenance windows](concepts.md#maintenance-windows) for the rules.

## tokens.json

The file is `{"tokens": [{"location": "east", "token": "<secret>"}]}`. Keep it out of git. Copy `tokens.example.json` as a start.

| Field      | Rule                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tokens`   | Array with at least one entry.                                                                                                   |
| `location` | Non-empty string, at most 64 characters after trim.                                                                              |
| `token`    | String of at least 16 characters, unique across the file. A value that starts with `replace-with-` is rejected as a placeholder. |

A token must not contain whitespace, must not start with `replace-with-` and must not be one of the public example tokens. A location may have several tokens. Create a token with `openssl rand -hex 32`. If the file is missing, not valid JSON or invalid, the API prints `pulse-api: <message>` and exits with code 1. The messages never print token values, and the start log only counts tokens and locations. See [Locations and tokens](concepts.md#locations-and-tokens).

## Compose variables

`compose.yaml` and `.env` use these variables. Copy `.env.example` to `.env` to set them.

| Variable                 | Default   | Meaning                                                                    |
| ------------------------ | --------- | -------------------------------------------------------------------------- |
| `PULSE_PROBE_TOKEN`      | empty     | Token of the probe. Compose also writes it to the API's tokens file.       |
| `PULSE_LOCATION`         | `default` | Location of the probe. It is the location of the token in the tokens file. |
| `PULSE_API_PORT`         | `3000`    | Host port of the API. Bound to 127.0.0.1.                                  |
| `PULSE_STATUS_PORT`      | `8080`    | Host port of the status page.                                              |
| `PULSE_DEMO_API_PORT`    | `3001`    | Host port of `demo-api` (demo profile). Bound to 127.0.0.1.                |
| `PULSE_DEMO_STATUS_PORT` | `8081`    | Host port of `demo-status` (demo profile).                                 |

`.env.example` sets `PULSE_PROBE_TOKEN` to the placeholder `replace-with-a-random-token` and `PULSE_LOCATION=default`. The two port lines are commented out. The API rejects the placeholder at start, so replace it with your own token. See [Install](install.md#the-env-file).
