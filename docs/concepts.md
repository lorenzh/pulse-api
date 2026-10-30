# Concepts

## Check states

A check is in one state. The state comes from the results that probes send.

| State         | Meaning                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`     | The check has no results yet (a heartbeat check: no ping yet and `period + grace` has not passed).                                                                                                |
| `up`          | The check answers and is fast enough.                                                                                                                                                             |
| `degraded`    | The check answers (2xx), but slower than its `latencyObjectiveMs`, or a domain registration has `warnDays` days or fewer left.                                                                    |
| `down`        | The check fails, a 2xx body lacks the `keyword`, a TLS certificate has `warnDays` days or fewer left, a TCP port refuses, a DNS answer is missing or wrong, or a domain registration has expired. |
| `maintenance` | `now` is inside a [maintenance window](#maintenance-windows). Never stored.                                                                                                                       |

A probe reports each result as `up`, `degraded` or `down`. The API computes the other states.

The `tcp` check is up when a connection opens (nothing is sent). The `dns` check is up when the record resolves to the expected values. The `domain` check reads the registration expiry (RDAP): `up` above `warnDays` days left, `degraded` from `warnDays` days down to 0, `down` when expired or when no expiry date can be read. This differs from a TLS check, which is `down` within `warnDays`. The API never judges expiry itself; the probe sets the status. TLS and domain results carry `certDaysLeft`.

## Heartbeat checks

A heartbeat check has one source, the job that pings. There is no quorum and no late-result logic: a ping is an `up` result, stamped by the API clock. The API ticks every second. A check is overdue when more than `period + grace` passed since the later of its last ping and the time this API process first saw the check. The state is `unknown` until then. When it is overdue, the API stores one `down` result (`no ping within <period+grace>ms`) and opens an incident at once, not after three results. It stores no more results during the same outage. The next ping resolves the incident. Because the wait counts from the start of the process, the downtime of the API itself never opens an incident. In a maintenance window pings are stored but no `down` result is written. `lastResultAt` is the time of the last ping.

## Quorum and incidents

Every accepted result triggers one evaluation of its check. The evaluation works like this:

1. The window is `[T - 2 * intervalMs, T]`, where `T` is the timestamp of the new result. Results newer than `T` are ignored.
2. Each location counts by its latest result in the window.
3. With one location in the window, it decides alone. A single probe can open an incident.
4. With two or more locations in the window, the combined status is `down` only when at least two of them are down. Otherwise it is `degraded` if any is degraded, else `up`.
5. The combined status feeds a counter. The third consecutive `down` evaluation opens an incident, if none is open. A combined `up` or `degraded` evaluation resets the counter and resolves an open incident. A single `up` or `degraded` result resolves it only when it makes the combined status `up` or `degraded`. With one location in the window that is always the case. With more locations it is not: two `down` locations keep the combined status `down`, even when a third reports `up`.

"Locations in the window" are the locations that sent a result in the window. They are not the locations configured in `tokens.json`. If one of two probes stops sending, its last result falls out of the window and the other probe decides alone.

Details:

- `openedAt` and `resolvedAt` are the timestamps of the results that triggered the change.
- The incident `reason` is the reason of the latest `down` result in the window.
- `lastReason` of a check is the reason of the latest ingested result.
- Incidents can open sooner than three intervals, because every location in the window adds results.
- The counter is stored in the database and survives restarts.
- `resolvedAt` is never earlier than `openedAt`. If the resolving result carries an older timestamp (another location's clock), the API stores `openedAt` instead.

### Maintenance and quorum

Whether a `down` result lies in a maintenance window is decided by its own timestamp (`start <= t < end`), not by the arrival time. Such a down never counts in a quorum window, also when it arrives after the window ended. A down at `end` counts. Windows come from the checks file at start, so a changed file applies from the next start.

### Late results

A result is late when its timestamp is strictly older than the newest stored result of the same check and the same location. A result that is older than the newest result of the same check in any other location is not marked late and still takes part in later quorum windows at its own timestamp, but it never changes the state, `consecutiveDown`, incidents, `lastResultAt` or `lastReason` either. Equal timestamps are not older. A late result is stored (marked `late` in the `results` table, not in the JSON) and appears in the results history. It is excluded from every later window, so it never takes part in the quorum. It does not change the state, `consecutiveDown`, incidents, `lastResultAt` or `lastReason`. Results of other locations keep their role in the quorum. A second result with the same timestamp in the same location is a repeat and is ignored (see [POST /results](rest-api.md#post-results)). `GET /uptime` is a history statistic and still counts late results.
- The counter is `consecutiveDown` in `GET /checks`.

Example: a check has `intervalMs` 10000 and one probe. Three `down` results in a row open an incident. The next `up` result resolves it.

## Probe locations

The API remembers, per location, the newest result timestamp (`lastResultAt`) and when it last received an accepted result. `GET /locations` shows `silent` when nothing was received for longer than `PULSE_LOCATION_SILENT_MS` (default `max(180000, 3 × the largest interval of the active non-heartbeat checks)`), else `reporting`. Receive time is used because a probe replays buffered results with old timestamps after an outage. See [GET /locations](rest-api.md#get-locations).

## Locations and tokens

A location is the name of a probe, for example `east`. Each result carries the location of the probe that produced it.

`POST /results` needs a probe token: `Authorization: Bearer <token>`. The token fixes the probe's location. Read routes (`GET`) are public.

Rules for locations:

- A location is trimmed, case-sensitive and at most 64 characters.
- A result without `location`, or with a blank one, is stored under the token's location.
- A result with a location that differs from the token's gets `403`. The probe's `PULSE_LOCATION` must therefore equal the location of its token.
- Results stored before locations existed count as location `default`.
- `GET /checks` lists every location ever seen for a check in `locations`. A location is `stale` when its latest result is older than two intervals before the newest result of the check.

Rules for tokens:

- The tokens file lists at least one entry. See [tokens.json](configuration.md#tokensjson).
- A location may have several tokens. This allows rotation without a gap (see [Operation](operation.md#token-rotation)).
- The API compares the presented token with every configured token in constant time per comparison and without early exit.
- Tokens are read at start. Restart the API to change them.
- Tokens travel in clear over plain HTTP. Run the API behind TLS or on a private network.

The `401` check comes before body checks, so a caller without a token learns nothing about the checks. Nothing is stored when a request is rejected.

## Retention

Raw results are deleted after `PULSE_RETENTION_DAYS` days (default and minimum 90, the window of `GET /uptime`).

- Resolved manual incidents are deleted with the same cutoff, by their resolution time.
- Retention counts whole UTC days including today. Results before the start of the UTC day `PULSE_RETENTION_DAYS - 1` days ago are deleted.
- The newest result of each check and location is always kept.
- Automatic incidents are never deleted.
- Cleanup runs at start and then hourly, in batches of 1000 rows.

The database file does not shrink after deletes. SQLite reuses the freed pages. See [Operation](operation.md#retention-and-disk-space).

## Uptime

`GET /uptime` returns the uptime of the last 90 UTC calendar days per check. A day's uptime is `(up + degraded results) / all results * 100`, unrounded. `degraded` counts as up, all locations count, and maintenance is not subtracted. A day without results has `uptime: null`: it is not down.

## Latency history and availability objective

`GET /latency` and `GET /checks/:id/latency` return the p50 and p95 latency of the last 90 UTC calendar days, today last. Only HTTP checks have latency; heartbeat, TLS, tcp, dns and domain checks are left out.

- A day counts the `up` and `degraded` results of all locations, late results included. `down` results carry no latency and are left out. `count` is the number of those results.
- Percentiles are nearest-rank: the value at 1-based index `ceil(p * n)` of the sorted `latencyMs`, with no interpolation. p50 of 10, 20, 30, 40 is 20; p95 of 20 values is the 19th. The values are the reported `latencyMs`, so they are as precise as the probe's.
- A day without such results has `p50Ms: null`, `p95Ms: null` and `count: 0`.
- Closed days are stored once in the table `latency_daily` and never recomputed on read. A result that arrives late for a closed day does not change its stored percentiles. Today is computed from the results at every read (after the 5 s cache). A database file from an older release gets the table when it is opened. The rows are filled by a background backfill that starts 5 s after the API listens and then runs hourly. It stores one day of one check per batch and yields to requests after each batch, and it computes only the closed days without a row. A read fills the days still missing for the checks it returns, so responses are the same before, during and after the backfill. The first backfill of a large history scans the results once.
- Rollups are removed with the same cutoff as raw results (`PULSE_RETENTION_DAYS`, at least 90 days) and when their check is no longer in the database.

A check or component with `availabilityTarget` carries `slo` in `GET /checks` and `GET /components`:

- `target`: the configured percent. `windowDays`: always 30.
- `availability`: percent over the last 30 UTC calendar days including today, from the same day buckets as `GET /uptime`: result-weighted, `degraded` counts as up, maintenance is not subtracted. A component merges its member checks as `GET /components/uptime` does. `null` without results.
- `budgetRemaining`: `100 * (1 - (1 - availability/100) / (1 - target/100))`, in percent of the error budget. It can be negative. Target 99.9 with availability 99.95 gives 50; availability 99.8 gives -100. `null` when `availability` is `null`.

The gauge `pulse_api_slo_budget_remaining_ratio{check}` and `{component}` carries the same budget as a ratio (0.5 is 50 %, -1 is -100 %), so it differs from `budgetRemaining` by the factor 100. It is omitted while the budget is `null`.

## Maintenance windows

Maintenance windows are listed in `checks.json` (see [maintenance](configuration.md#maintenance)). A result is classified by its own timestamp.

- A `down` result inside a window is stored and updates `lastResultAt` and `lastReason`. It leaves the stored state, the counter and the incidents untouched.
- An `up` or `degraded` result is processed as usual: it goes through the quorum evaluation. Example: two of three locations are down and open an incident. A third location then reports `up` during maintenance. Two locations are still down, so the combined status stays `down` and the incident stays open.
- An incident that is open when a window starts stays open.
- While `now` is inside a window, `GET /checks` shows `state: "maintenance"` and the active window in `maintenance`, whatever the stored state. Afterwards the stored state shows again.
- Windows of one check can overlap. They form a union, and the one with the earliest `start` is reported.
