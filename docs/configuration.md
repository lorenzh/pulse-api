# Configuration

The API is configured by environment variables and two JSON files. It reads them at start. The checks file is also reloaded while the API runs (see [Changing checks](operation.md#changing-checks)); a change to the environment or to the tokens files needs a restart.

## Environment variables

| Variable                          | Default         | Meaning                                                                                                                                                                                   |
| --------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                            | `3000`          | HTTP port. An integer from 0 to 65535.                                                                                                                                                    |
| `PULSE_DB`                        | `./pulse.db`    | Path of the SQLite file. It is created if it does not exist.                                                                                                                              |
| `PULSE_CHECKS_FILE`               | `./checks.json` | Path of the [checks file](#checksjson).                                                                                                                                                   |
| `PULSE_TOKENS_FILE`               | `./tokens.json` | Path of the [tokens file](#tokensjson).                                                                                                                                                   |
| `PULSE_API_ADMIN_TOKENS_FILE`     | unset           | Path of the [admin tokens file](#admin-tokensjson). Unset turns the write routes of manual incidents and the [admin config routes](rest-api.md#admin-config-routes) off.                  |
| `PULSE_CHECKS_RELOAD_INTERVAL_MS` | `5000`          | Time between two looks at the checks file for a change. `0` turns the look off; else an integer from 1000 to 3600000. See [Hot reload](operation.md#changing-checks).                     |
| `PULSE_RETENTION_DAYS`            | `90`            | Days of raw results to keep. An integer of at least 90.                                                                                                                                   |
| `PULSE_LOCATION_SILENT_MS`        | derived         | Silence after which a probe location is `silent` in `GET /locations`. An integer from 1 to 2147483647. Unset: `max(180000, 3 × the largest interval of the active non-heartbeat checks)`. |
| `PULSE_LOG_LEVEL`                 | `info`          | `debug`, `info`, `warn` or `error`. Another value stops the start.                                                                                                                        |

The Docker image sets `NODE_ENV=production` and `PULSE_DB=/data/pulse.db`.

`PULSE_RETENTION_DAYS` that is not an integer of at least 90 stops the start with `PULSE_RETENTION_DAYS: must be an integer >= 90`. An unset or empty value means 90. See [Retention](concepts.md#retention).

`PULSE_LOCATION_SILENT_MS` that is not an integer from 1 to 2147483647 stops the start with `PULSE_LOCATION_SILENT_MS: must be an integer from 1 to 2147483647`. See [Probe locations](concepts.md#probe-locations).

Example:

```sh
PORT=3100 PULSE_DB=/var/lib/pulse/pulse.db PULSE_CHECKS_FILE=/etc/pulse/checks.json \
  PULSE_TOKENS_FILE=/etc/pulse/tokens.json PULSE_RETENTION_DAYS=180 bun start
```

## Exit codes

| Code | Meaning                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Clean stop after `SIGINT` or `SIGTERM`.                                                                                                                                               |
| `2`  | Configuration or startup error: a setting, the checks file, the tokens file, the database cannot be opened or the port is taken. One line `pulse-api: <message>` on stderr, no stack. |
| `1`  | Unexpected failure. A JSON error log line with the stack.                                                                                                                             |

Before this version the tokens file error exited with code 1, and other configuration errors printed a stack. Update scripts that test for code 1.

## checks.json

The file is `{"checks": [...], "maintenance": [...], "components": [...]}`. `maintenance` and `components` are optional. The checks are validated and upserted into the database at start. Existing state and results are kept. An invalid or unreadable file stops the start with one line `pulse-api: <path>: <message>` and exit code 2. A key that is not documented below is rejected, at the top level, in a check and in a `maintenance` window: `<path>: unknown key "keywrod" in checks[2]`. A `tls` check accepts only its own keys (`host`, `port`, `warnDays`, `intervalMs` and the common ones). Probes read the same checks from `GET /checks`. Values outside the documented ranges are rejected, with the cap 2147483647 (2^31-1, the largest timer delay) for `intervalMs`, `timeoutMs` and `latencyObjectiveMs`. A checks file that held out-of-range values before now fails to load.

An explicit `null` is rejected for `type`, `retries`, `retryDelayMs`, the TLS `port` and `warnDays`, and the heartbeat `grace`; leave the key out to get the default. This is deliberate. The messages are, for example, `checks[0].retries must be an integer from 0 to 10`, `checks[0].port must be an integer from 1 to 65535` and `checks[0].grace must be an integer from 0 to 86400000 (milliseconds)`; a `null` type reports `checks[0].type Invalid input: expected "http"`.

See `checks.example.json` for a complete example.

### Fields of every check

| Field                | Required | Meaning                                                                                                                                                                                                                                                               |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | yes      | Non-empty string, unique in the file.                                                                                                                                                                                                                                 |
| `name`               | yes      | Non-empty string.                                                                                                                                                                                                                                                     |
| `type`               | no       | `"http"` (default), `"tls"`, `"tcp"`, `"dns"`, `"domain"` or `"heartbeat"`. Any other value is rejected.                                                                                                                                                              |
| `intervalMs`         | yes      | Integer 1 to 2147483647, milliseconds between probes.                                                                                                                                                                                                                 |
| `timeoutMs`          | no       | Integer 1 to 2147483647, milliseconds. When omitted, the probe uses its own default (5000).                                                                                                                                                                           |
| `availabilityTarget` | no       | Number from 90 up to, but not including, 100: the 30-day availability objective in percent. Allowed on every check type, also `tls` and `heartbeat`. Absent means no objective. See [Availability objective](concepts.md#latency-history-and-availability-objective). |

### HTTP checks

An HTTP check has `type` absent or `"http"` and these fields besides the common ones:

| Field                | Required | Meaning                                                                                                                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                | yes      | `http` or `https` URL to probe.                                                                                                                                         |
| `retries`            | no       | Integer 0 to 10, default 0. Extra attempts the probe makes after a failed one before it reports `down`.                                                                 |
| `retryDelayMs`       | no       | Integer 0 to 60000, default 1000. Wait between attempts.                                                                                                                |
| `latencyObjectiveMs` | no       | Integer 1 to 2147483647, milliseconds. A successful (2xx) result slower than this is `degraded`. Absent means no objective.                                             |
| `keyword`            | no       | Non-empty string, case-sensitive substring. A 2xx answer whose body does not contain it is `down` with the reason `keyword "<text>" not found`. Rejected on TLS checks. |
| `method`             | no       | `GET` (default), `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`. Upper case.                                                                                     |
| `headers`            | no       | Object of request headers, at most 20. A value is a string or `{"env": "NAME"}`.                                                                                        |
| `body`               | no       | Request body, at most 65536 bytes. Not allowed with `GET` or `HEAD`. No `Content-Type` is added: set it in `headers`.                                                   |
| `expectedStatus`     | no       | Non-empty list, at most 20, of integers 100 to 599 or ranges `"lo-hi"`. Default `["200-299"]`. The probe judges the final status after redirects.                       |
| `jsonAssert`         | no       | List of at most 10 assertions on the JSON body, see below. Not allowed with `HEAD`.                                                                                     |

A `jsonAssert` item is `{ "pointer": "/a/b", "equals": <JSON> }` or `{ "pointer": "/a/b", "exists": true }`. `pointer` is an RFC 6901 JSON pointer (an empty string is the whole document).

The contract (`@lorenzh/pulse-contract`) owns the exact limits: header names must be tokens and may not be `host`, `content-length`, `transfer-encoding`, `connection` or `user-agent`; names are unique ignoring case; names and literal values total at most 16 KiB. The new fields are rejected on TLS and heartbeat checks. A validation error names the field path and never quotes a value.

Notes:

- **Secrets.** Use `{"env": "PULSE_HEADER_NAME"}` for a secret. The name must start with `PULSE_HEADER_` (case-sensitive). The probe resolves it from its own environment, so the secret lives in the probe's environment and never in the API's. The API never resolves an `env` reference. A check whose variable is unset, or whose name lacks the prefix, is skipped by that probe, with a log line that names the variable. Every probe location needs the variable. The variable replaces the whole header value, so a bearer token needs the scheme in the variable (`Bearer <token>`).
- **Redirects.** A check with `headers` or a `body` follows a redirect only to the same origin (scheme, host and port). A redirect to another origin, from https to http, or from http to https is not followed: the check is `down` with the reason `redirect to <origin> not followed`. A `301`, `302` or `303` answer to a check whose method is not `GET` is `down`, with the reason `HTTP <status> redirect not followed for <METHOD>`. At most 20 redirects are followed.
- **Clear text.** Literal header values and bodies are clear text in the checks file and in the API database.
- **Migration.** Rename each variable in every probe location and in the checks file, for example `SVC_TOKEN` to `PULSE_HEADER_SVC_TOKEN`. Until then the probe skips those checks.
- A literal header value and a `body` are stored in the API database and served to every probe that sends a valid token on `GET /probe/checks`. Treat the checks file, the database and the probe tokens as sensitive.
- `GET /checks` (public) never serves `headers`, `body` or `jsonAssert`, not even names. It serves `method` and `expectedStatus` only when they are not the defaults. See [REST API](rest-api.md#get-probechecks).
- **Rollout order.** Upgrade the contract, then every probe and the status page, then the API. A new probe falls back to `GET /checks` when `GET /probe/checks` answers `404`. An old probe reads only the public `GET /checks`, so it would misjudge a non-default `method` or `expectedStatus`: upgrade all probes before you add these fields to the checks file.
- Failure reasons the probe writes: `HTTP <code> not in <expectedStatus>`, `keyword "<text>" not found`, `json: invalid body`, `json <pointer>: expected <JSON>, got <JSON>` and `json <pointer>: missing`.

- The probe looks for the keyword within the first 1 MiB (1,048,576 bytes) of the body. Reading the body counts towards the latency.
- When a check is removed from the checks file, its `keyword`, `method`, `headers`, `body`, `expectedStatus` and `jsonAssert` are cleared at the next start. The check and its results stay, but the check is inactive: see [Changing checks](operation.md#changing-checks).
- An objective at or above `timeoutMs` can never be degraded.
- `GET /checks` always serves the resolved `retries` and `retryDelayMs`.
- When `retries` is above 0, the file is rejected unless the worst case `(retries + 1) * timeoutMs + retries * retryDelayMs` fits within `intervalMs`. `timeoutMs` defaults to 5000 in this formula.
- Results carry `attempts`, the number of attempts made (at least 1).

### TLS checks

A TLS check (`"type": "tls"`) watches the expiry of the leaf certificate of a server. It takes no `url`.

| Field      | Required | Meaning                                                                                 |
| ---------- | -------- | --------------------------------------------------------------------------------------- |
| `host`     | yes      | Host name or IP without scheme, port or path.                                           |
| `port`     | no       | Integer 1 to 65535, default 443.                                                        |
| `warnDays` | no       | Integer 0 or more, default 14. The check is down when this many days or fewer are left. |

Only the expiry of the leaf certificate is judged. The chain and the host name are not verified. Results carry `certDaysLeft`. `GET /checks` shows the latest value and `GET /checks/:id/results` includes it. A TLS check ignores `retries`, `retryDelayMs` and `latencyObjectiveMs`.

### TCP checks

A TCP check (`"type": "tcp"`) is up when a connection to `host:port` opens. The probe closes it at once and sends nothing.

| Field                     | Required | Meaning                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------- |
| `host`                    | yes      | Non-empty host name or IP.                                          |
| `port`                    | yes      | Integer 1 to 65535.                                                 |
| `intervalMs`              | yes      | Integer 1 to 2147483647.                                            |
| `timeoutMs`               | no       | Integer 1 to 2147483647.                                            |
| `retries`, `retryDelayMs` | no       | As for HTTP checks: 0 to 10 (default 0), 0 to 60000 (default 1000). |

Reasons: `connection refused (ECONNREFUSED)`, `host not found (ENOTFOUND)`, `timeout after <ms>ms`.

```json
{
  "id": "db",
  "name": "Database port",
  "type": "tcp",
  "host": "db.example.com",
  "port": 5432,
  "intervalMs": 30000
}
```

### DNS checks

A DNS check (`"type": "dns"`) resolves a record and compares the answer.

| Field        | Required | Meaning                                                                                                                                                       |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dnsName`    | yes      | Host name to resolve (`name` is the display name of every check).                                                                                             |
| `recordType` | yes      | `A`, `AAAA`, `CNAME`, `MX`, `TXT` or `NS` (upper case).                                                                                                       |
| `expected`   | no       | 1 to 20 non-empty strings. The answer must contain all of them (extra records are fine). MX values are `<priority> <exchange>`. Without it, any answer is up. |
| `resolver`   | no       | IPv4 or IPv6 address of the resolver, no port and no host name. Default: the system resolver.                                                                 |

It also takes `intervalMs`, `timeoutMs`, `retries` and `retryDelayMs` like a TCP check. Reasons: `NXDOMAIN: <dnsName> does not exist`, `no <TYPE> record for <dnsName>`, `expected [..], got [..]`, `timeout after <ms>ms`.

```json
{
  "id": "www-dns",
  "name": "www A record",
  "type": "dns",
  "dnsName": "www.example.com",
  "recordType": "A",
  "expected": ["192.0.2.10"],
  "intervalMs": 60000
}
```

### Domain checks

A domain check (`"type": "domain"`) watches the registration expiry through RDAP (no WHOIS).

| Field        | Required | Meaning                                                                           |
| ------------ | -------- | --------------------------------------------------------------------------------- |
| `domain`     | yes      | Lowercase domain name with at least two labels, without scheme, port or path.     |
| `warnDays`   | yes      | Integer 0 or more. The check is `degraded` when this many days or fewer are left. |
| `intervalMs` | yes      | At least 3600000 (1 hour). There is no default.                                   |

It also takes `timeoutMs`, `retries` and `retryDelayMs`. The check is `down` when the domain has expired (`domain expired`) or no expiry date is found (`expiry date not found in RDAP answer`). Results carry `certDaysLeft` (whole days, negative when expired). Registries without RDAP, such as some country codes, give `down`.

```json
{
  "id": "example-domain",
  "name": "example.com registration",
  "type": "domain",
  "domain": "example.com",
  "warnDays": 30,
  "intervalMs": 3600000
}
```

### Privacy of targets

`host`, `port` (tcp), `dnsName`, `expected`, `resolver` and `domain` are check targets, served like a TLS `host` and `port`: `GET /probe/checks` and `GET /checks` carry them. The status page keeps them private by default. These types reject the HTTP-only fields (`url`, `method`, `headers`, `body`, `expectedStatus`, `jsonAssert`, `keyword`, `latencyObjectiveMs`) with `<path> is not allowed on a <type> check`. Probes must be updated before such a check is added; see [Rolling out a new check type](operation.md#rolling-out-a-new-check-type).

### Heartbeat checks

A heartbeat check (`"type": "heartbeat"`) is for cron jobs and workers. The job pings the API; the check is `down` when no ping arrives within `period + grace`. The probe never runs it. It takes no `url`, `host`, `intervalMs`, `timeoutMs` or `keyword`.

| Field    | Required | Meaning                                                                                                 |
| -------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `period` | yes      | Expected time between pings in ms, integer 1000 to 86400000.                                            |
| `grace`  | no       | Extra wait in ms before the check is down, integer 0 to 86400000, default 0.                            |
| `secret` | yes      | 16 to 128 characters from `A-Z a-z 0-9 . _ ~ -`. The credential of the ping. Allowed on this type only. |

The secret is kept in memory only. `GET /checks`, `/metrics`, incident reasons and error messages never contain it. It is not a probe token: a probe token cannot ping, and the secret cannot post to `/results`. See [Heartbeat checks](operation.md#heartbeat-checks) for use and [GET|POST /heartbeat/:id](rest-api.md#getpost-heartbeatidsecret) for the endpoint.

### maintenance

`maintenance` is an array of windows. A missing key means no windows.

| Field     | Required | Meaning                                                               |
| --------- | -------- | --------------------------------------------------------------------- |
| `checkId` | yes      | Id of a configured check.                                             |
| `start`   | yes      | ISO 8601 string with an explicit offset (`Z` or `±hh:mm`), inclusive. |
| `end`     | yes      | Same format, exclusive, must be after `start`.                        |
| `note`    | yes      | Non-empty string shown with the maintenance state.                    |

`start` and `end` must be real calendar dates (`2030-02-30` is rejected, `2028-02-29` is fine), and `end` must be after `start`. A window with a missing note and a reversed range reports the note first: `maintenance[0].note is required and must be a non-empty string`. Windows are read at start only. See [Maintenance windows](concepts.md#maintenance-windows) for the rules.

### components

`components` is an array of customer-facing groups of checks, served by `GET /components` and `GET /components/uptime`. A missing key means no components. Both routes are public like the other reads: the status page proxies them without a token. They are not part of `GET /probe/checks`.

| Field                | Required | Meaning                                                                                                             |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                 | yes      | `^[a-z0-9][a-z0-9._-]*$`, at most 64 characters, unique among components.                                           |
| `name`               | yes      | Plain text, 1 to 100 characters.                                                                                    |
| `description`        | no       | Plain text, at most 500 characters.                                                                                 |
| `group`              | no       | Section heading, plain text, 1 to 100 characters.                                                                   |
| `checkIds`           | yes      | Non-empty list of configured check ids without duplicates.                                                          |
| `availabilityTarget` | no       | As on a check: 90 up to, but not including, 100, percent. The availability of a component merges its member checks. |

A check may be in several components. A component id may equal a check id. An unknown key, an unknown check id or a duplicate component id stops the start, for example `components[0].checkIds[1] must reference a configured check`. A change to components applies without a restart, like the rest of the file (see [Changing checks](operation.md#changing-checks)); an invalid file is not applied and the running components stay.

## tokens.json

The file is `{"tokens": [{"location": "east", "token": "<secret>"}]}`. Keep it out of git. Copy `tokens.example.json` as a start.

| Field      | Rule                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tokens`   | Array with at least one entry.                                                                                                   |
| `location` | Non-empty string, at most 64 characters after trim.                                                                              |
| `token`    | String of at least 16 characters, unique across the file. A value that starts with `replace-with-` is rejected as a placeholder. |

A token must not contain whitespace, must not start with `replace-with-` and must not be one of the public example tokens. A location may have several tokens. Create a token with `openssl rand -hex 32`. If the file is missing, not valid JSON or invalid, the API prints `pulse-api: <message>` and exits with code 2. Each error message ends with `(PULSE_TOKENS_FILE=<path>)`. The messages never print token values, and the start log only counts tokens and locations. See [Locations and tokens](concepts.md#locations-and-tokens).

## admin-tokens.json

Optional. Set `PULSE_API_ADMIN_TOKENS_FILE` to enable `POST`, `DELETE` on `/manual-incidents`. The file is `{"tokens": [{"name": "ops", "token": "<secret>"}]}`. Copy `admin-tokens.example.json` as a start and keep the file out of git.

| Field    | Rule                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `tokens` | Array with at least one entry.                                                                              |
| `name`   | Non-empty string; only for your own bookkeeping.                                                            |
| `token`  | The same rules as a probe token: 16 or more characters, no whitespace, not a placeholder or public example. |

An admin token must differ from every probe token, and tokens must not repeat. Either error stops the start with `pulse-api: <message> (PULSE_API_ADMIN_TOKENS_FILE=<path>)` and exit code 2. Messages never print token values and the start log only counts tokens. Without the setting the manual incidents feature is off: the write routes answer `404`, `GET /manual-incidents` answers `200` with an empty list and `GET /manual-incidents/<id>` answers `404`, even when the database holds incidents. The stored incidents come back when the setting is set again. The tokens are compared in constant time.

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
