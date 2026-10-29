# Troubleshooting

Each entry quotes a message from the code.

## The API does not start

### `token must be a string of at least 16 characters`

Full text: `pulse-api: tokens[0] (location "<name>") token must be a string of at least 16 characters`. The token is too short or empty. With Compose, `.env` is missing, so `PULSE_PROBE_TOKEN` is empty. Copy `.env.example` to `.env`, or create a token with `openssl rand -hex 32`.

### `still has the example placeholder token`

A token starts with `replace-with-`. You copied `tokens.example.json` without editing it. Replace every token.

### `cannot read tokens file <path>`

The file does not exist or is not readable. Check `PULSE_TOKENS_FILE` and, in Docker, the mount.

### `tokens file <path> is not valid JSON`

Fix the JSON. The message does not quote the file, so that no token leaks.

### Other tokens file messages

- `tokens file must be an object with a "tokens" array`
- `tokens file needs at least one entry`
- `tokens[<i>] must be an object`
- `tokens[<i>].location must be a non-empty string`
- `tokens[<i>].location must be at most 64 characters`
- `tokens[<i>] repeats the token of tokens[<j>]`: each token must be unique.

See [tokens.json](configuration.md#tokensjson).

### `ConfigError: ...` and a stack trace (checks file)

The checks file is invalid. The first line starts with `ConfigError:`. The message names the entry, for example `checks[0].url is not a valid URL` or `duplicate check id "example"`. Fix the file. Messages you may see:

- `cannot read checks file <path>: ...`: wrong `PULSE_CHECKS_FILE`, or the file is not mounted.
- `checks file <path> is not valid JSON: ...`
- `config must be an object with a "checks" array`
- `checks[<i>].intervalMs must be a positive integer (milliseconds)`
- `checks[<i>]: worst case <n> ms ((retries + 1) * timeoutMs + retries * retryDelayMs) exceeds intervalMs <n>`: lower `retries`, `retryDelayMs` or `timeoutMs`, or raise `intervalMs`.
- `maintenance[<i>].checkId must reference a configured check`
- `maintenance[<i>].start must be an ISO 8601 string with an explicit offset (Z or ±hh:mm)`
- `maintenance[<i>].end must be after start`

See [checks.json](configuration.md#checksjson).

### `RetentionConfigError: PULSE_RETENTION_DAYS must be an integer >= 90, got "<value>"`

Set `PULSE_RETENTION_DAYS` to an integer of at least 90, or unset it.

### `EADDRINUSE`

Port 3000 (or `PORT`) is in use. Choose another `PORT`. With Compose, change `PULSE_API_PORT`.

## 400 on POST /results

The body is invalid. The message names the field:

- `body is not valid JSON`
- `body must be a JSON object`
- `checkId must be a non-empty string`
- `timestamp must be a number`
- `status must be "up", "degraded" or "down"`
- `statusCode must be an integer or null`
- `latencyMs must be a non-negative number`
- `reason must be a string or null`
- `certDaysLeft must be an integer or null`
- `attempts must be an integer >= 1`
- `location must be a string`
- `location must be at most 64 characters`: a location longer than 64 characters after trim. Use a shorter `PULSE_LOCATION`.

## 401 on POST /results

`{"error":"unauthorized"}` with `WWW-Authenticate: Bearer`. The `Authorization` header is missing, is not `Bearer <token>`, or the token is not in the tokens file. Check that the probe's `PULSE_PROBE_TOKEN` is in the tokens file, and that the API was restarted after you added it.

## 403 on POST /results

`{"error":"location does not match token"}`. The probe sent a location that differs from the location of its token. Make the probe's `PULSE_LOCATION` equal to the `location` of its token entry. See [Locations and tokens](concepts.md#locations-and-tokens).

## 404 on POST /results

`unknown check "<id>"`. The check id is not in the checks file the API loaded. The probe and the API use different check lists, or the API was not restarted after you added the check. Restart the API, then the probe.

## 404 on GET /checks/:id/results

`unknown check "<id>"`. The id does not match a check. Ids are case-sensitive.

## 400 on GET requests

- `limit must be a positive integer` on `/checks/:id/results`.
- `status must be "open" or "resolved"` on `/incidents`.
- `bad check id` on `/checks/:id/results`: the id has a malformed percent escape.

## 405 and 413

- `method not allowed`: use `POST` on `/results` and `GET` on every other path.
- `request body too large`: bodies over 1,000,000 bytes are refused.

## No incident opens although a check is down

An incident opens at the third consecutive `down` evaluation. Check these points:

- The check state in `GET /checks` shows `consecutiveDown`. It must reach 3.
- With two or more locations in the window, at least two must be down. One failing location is not enough. See [Quorum and incidents](concepts.md#quorum-and-incidents).
- `down` results inside a [maintenance window](concepts.md#maintenance-windows) do not count.

## A check stays `unknown`

No probe has posted a result yet. Check that the probe runs, that it reaches the API, and that it logs no `401` or `403`. The probe reads its checks at start, so restart it after you add a check.

## The status page is stale

The status page shows what `GET /checks` returns. If a location is `stale` in `GET /checks`, its probe stopped sending. If no location sends, `lastResultAt` stops moving. Check the probe and its token. Then check the status page's `PULSE_API_URL` and its logs, see the [pulse-status docs](https://github.com/lorenzh/pulse-status/blob/main/docs/index.md).

## `retention failed: ...`

The cleanup threw an error, for example because the disk is full or the file is locked. The API keeps running and tries again after an hour. Read the message after the colon.
