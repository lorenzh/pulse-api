# Troubleshooting

Each entry quotes a message from the code.

## The API does not start

### `token must be a string of at least 16 characters`

Full text: `pulse-api: tokens[0] (location "<name>") token must be a string of at least 16 characters`. The token is too short or empty. With Compose, `.env` is missing, so `PULSE_PROBE_TOKEN` is empty. Copy `.env.example` to `.env` and set a token with `openssl rand -hex 32`.

### `still has the example placeholder token`

A token starts with `replace-with-`. You copied `tokens.example.json` or `.env.example` without editing it. Replace every token, for example with `openssl rand -hex 32`.

### `uses a public example token: generate your own`

The token is one of the example tokens from earlier versions of the docs and `.env.example`. They are public. Replace the token in `.env` or the tokens file, and in the probe.

### `token must not contain whitespace`

The token has a space, tab or newline, often a trailing newline from a copy. Remove it.

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

### `pulse-api: <path>: ...` (checks file)

The checks file is invalid. The API prints one line `pulse-api: <path>: <message>` and exits with code 2. The message names the entry, for example `checks[0].url is not a valid URL` or `duplicate check id "example"`. Fix the file. Messages you may see:

- `cannot read checks file <path>: ...`: wrong `PULSE_CHECKS_FILE`, or the file is not mounted.
- `checks file <path> is not valid JSON: ...`
- `config must be an object with a "checks" array`
- `unknown key "<key>" in checks[<i>]` (also `maintenance[<i>]` and `the top level`): a key the API does not know, often a typo such as `keywrod`. Fix or remove it.
- `checks[<i>].intervalMs must be an integer from 1 to 2147483647 (milliseconds)`
- `checks[<i>]: worst case <n> ms ((retries + 1) * timeoutMs + retries * retryDelayMs) exceeds intervalMs <n>`: lower `retries`, `retryDelayMs` or `timeoutMs`, or raise `intervalMs`.
- `maintenance[<i>].checkId must reference a configured check`
- `maintenance[<i>].start must be an ISO 8601 string with an explicit offset (Z or ±hh:mm)`
- `maintenance[<i>].end must be after start`

A wrong type reads like an out-of-range value, for example `checks[0].intervalMs must be an integer from 1 to 2147483647 (milliseconds)` for a string. The file is read with zod schemas, which report only the first problem, in this order: unknown keys, then the fields of the check. Messages that changed with the zod parser:

- A field with the wrong type has the same message as an out-of-range value.
- A `keyword` on a tls check is reported with the other field errors of that check (`checks[<i>].keyword is not allowed on a tls check`).
- The first problem of an invalid check can differ when it has several, for example a check with an unknown key and a missing `id` reports the unknown key.

See [checks.json](configuration.md#checksjson).

### `pulse-api: PULSE_RETENTION_DAYS: must be an integer >= 90`

The API exits with code 2. Set `PULSE_RETENTION_DAYS` to an integer of at least 90, or unset it.

### `pulse-api: PULSE_LOCATION_SILENT_MS: must be an integer from 1 to 2147483647`

The setting is not a positive integer in milliseconds within the timer limit. Fix or unset it; unset derives the threshold from the check intervals.

### `pulse-api: cannot listen on port <n> (PORT): ...`

The API exits with code 2. Port 3000 (or `PORT`) is in use. Choose another `PORT`. With Compose, change `PULSE_API_PORT`.

## 400 on POST /results

The body is invalid. The message names the field. `body is not valid JSON` comes first. Then the contract validator checks the shape, and its messages start with a path, for example `result: must be an object`, `result.checkId: must be a non-empty string`, `result.timestamp: must be an integer`, `result.status: must be one of "up", "degraded", "down"`, `result.statusCode: must be an integer 100..599` (or null), `result.latencyMs: must be a finite number >= 0`, `result.reason: must be a string`, `result.attempts: must be an integer >= 1` or `result.location: must be a string`. The api bound checks below run after it:

- `timestamp is more than <limit> ms in the future`: the probe's clock is more than the limit ahead (the check's interval, at most 60 s) of the API's. The probe does not fix this by itself; the result is rejected on every post until the clocks agree. Synchronise the clock (NTP). The probe drops a result the API answers with HTTP 400, logs `dropping result for <check>: API answered HTTP 400`, and does not retry it. Network errors are also logged as dropped.
- `timestamp is older than 7 days`
- `latencyMs must be a number from 0 to 86400000`
- `reason must be at most 1000 characters`
- `attempts must be an integer from 1 to 100`
- `location must be at most 64 characters`: a location longer than 64 characters after trim. Use a shorter `PULSE_LOCATION`.

## 401 on POST /results

`{"error":"unauthorized"}` with `WWW-Authenticate: Bearer`. The `Authorization` header is missing, is not `Bearer <token>`, or the token is not in the tokens file. Check that the probe's `PULSE_PROBE_TOKEN` is in the tokens file, and that the API was restarted after you added it.

## 403 on POST /results

`{"error":"location does not match token"}`. The probe sent a location that differs from the location of its token. Make the probe's `PULSE_LOCATION` equal to the `location` of its token entry. See [Locations and tokens](concepts.md#locations-and-tokens).

## 404 on POST /results

`unknown check "<id>"`. The check id is not in the checks file the API loaded, or the check was removed from the file (it is inactive). The probe and the API use different check lists, or the API was not restarted after you changed the file. Restart the API; the probe reloads its checks within its reload interval.

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

## 401 on /heartbeat/:id

The secret is wrong or missing, or the id is not in the checks file. The answer is the same for all three. Compare the id and `secret` in `checks.json`; the API reads the file at start only. A probe token is not a ping secret. A check that was removed from the file has no secret and also answers `401`.

## A heartbeat check is down

No ping arrived within `period + grace`. Run the job's `curl` by hand and look for `204`. The first wait counts from the start of the API, so a restart delays the first `down`. A heartbeat incident has the reason `no ping within <ms>ms`.

## A check stays `unknown`

No probe has posted a result yet. Check that the probe runs, that it reaches the API, and that it logs no `401` or `403`. After you add a check, restart the API; the probe picks the check up at its next reload.

## A location is `silent` in `GET /locations`

The API received no accepted result from that location for longer than the silent threshold. Check that the probe runs, that it reaches the API and that it logs no `401` or `403`. A probe that cannot reach the API buffers its results and the location turns `reporting` again as soon as it delivers. `PULSE_LOCATION_SILENT_MS` changes the threshold. After an API restart each location counts as seen at the timestamp of its newest stored result: it is `reporting` while that result is younger than the threshold and `silent` after that, until its probe posts again.

## The status page is stale

The status page shows what `GET /checks` returns. If a location is `stale` in `GET /checks`, its probe stopped sending. If no location sends, `lastResultAt` stops moving. Check the probe and its token. Then check the status page's `PULSE_API_URL` and its logs, see the [pulse-status docs](https://github.com/lorenzh/pulse-status/blob/main/docs/index.md).

## `retention failed: ...`

The cleanup threw an error, for example because the disk is full or the file is locked. The API keeps running and tries again after an hour. Read the message after the colon.
