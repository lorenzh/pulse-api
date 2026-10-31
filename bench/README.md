# Performance bench

`bench/` measures CPU time and memory of every pulse service under a fixed load and compares two versions (A and B) in one job. A nightly GitHub workflow (`.github/workflows/bench.yml`, 02:17 UTC, `main` only) runs it. It is not part of `bun test`.

## What is measured

| Metric key                     | Meaning                                                        | Services                   | Gates |
| ------------------------------ | -------------------------------------------------------------- | -------------------------- | ----- |
| `startup_cpu_ms`               | CPU time (utime + stime) at the first `200` of `/readyz`       | api, probe, status, notify | yes   |
| `load_cpu_s`                   | CPU time during the 60 s measured load window                  | api, probe, status, notify | yes   |
| `idle_rss_mib`                 | `VmRSS` after startup and 30 s without requests                | api, probe, status, notify | yes   |
| `peak_rss_mib`                 | `VmHWM` at the end of the load phase                           | api, probe, status, notify | yes   |
| `test_cpu_s`                   | CPU time of `bun run test` in the repository                   | all seven repositories     | yes   |
| `build_cpu_s`                  | CPU time of `bun run build`                                    | contract, kit              | yes   |
| `startup_wall_ms`              | Wall time from `compose up` to the first `200` of `/readyz`    | api, probe, status, notify | no    |
| `p95_get_checks_ms`            | p95 latency of `GET /checks` under load                        | api                        | no    |
| `p95_post_results_ms`          | p95 latency of `POST /results` under load                      | api                        | no    |
| `p95_get_latency_ms`           | p95 latency of `GET /latency` under load                       | api                        | no    |
| `p95_get_check_latency_ms`     | p95 latency of `GET /checks/:id/latency` under load            | api                        | no    |
| `rps`                          | Requests per second of all five streams in the window          | api                        | no    |
| `image_mb`                     | `docker image inspect` size                                    | api, probe, status, notify | no    |
| `cold_get_checks_ms`           | Wall time of the first `GET /checks` after a restart, 10x seed | api                        | no    |
| `cold_get_uptime_ms`           | Wall time of the `GET /uptime` right after it                  | api                        | no    |
| `cold_read_cpu_ms`             | API CPU time of those two reads                                | api                        | yes   |
| `cold_concurrent_ms`           | Wall time until both answered, sent at once after a restart    | api                        | no    |
| `eod_get_checks_ms`            | p95 of `GET /checks` right after one ingest, full day of today | api                        | no    |
| `eod_get_uptime_ms`            | The same for `GET /uptime`                                     | api                        | no    |
| `eod_get_latency_ms`           | The same for `GET /latency`                                    | api                        | no    |
| `eod_get_check_latency_ms`     | The same for `GET /checks/c0/latency`                          | api                        | no    |
| `eod_get_components_ms`        | The same for `GET /components`                                 | api                        | no    |
| `eod_get_components_uptime_ms` | The same for `GET /components/uptime`                          | api                        | no    |
| `eod_read_cpu_ms`              | API CPU time of the 20 end-of-day cycles, the POSTs included   | api                        | yes   |

Only CPU time and memory gate. Hosted runners are too noisy for wall-clock numbers, so latency, throughput and wall-clock startup are only reported. Image size is deterministic, but gating it is not a decision that was made, so it is reported too.

Process numbers are read from inside the container: each service is PID 1, so `docker exec <container> cat /proc/1/stat` and `/proc/1/status` give its own CPU time and memory, without healthcheck or exec processes and without page cache. CPU time has a resolution of 10 ms.

## The load

The constants are in `bench/load.ts`. The api database is seeded with 20 checks and 30 days of 1-minute results (864 000 rows) by `bench/seed.ts`, using the `src/db.ts` of the version under test. Three simulated probes send together 30 `POST /results` per second, round robin over the checks. Besides that, 10 `GET /checks`, 1 `GET /uptime`, 1 `GET /latency` and 1 `GET /checks/:id/latency` per second. Every bench check has an `availabilityTarget` (99.5), so `GET /checks` builds an `slo` for each. Before the load, the harness checks for each latency route whether side A's api ref contains the commit that added it (`OPTIONAL_ROUTES` in `bench/load.ts`, `git merge-base --is-ancestor`). A route whose commit A does not contain is not requested on A, and its p95 metric is marked `not available on A`. Every route that is requested must answer `200` on both sides: a `404` from a route that A has, or from side B, fails the run. The real probe, status page and notify run as configured in `bench/compose.bench.yaml`; the probe checks the 20 checks every 10 s against a trivial `bench-target` container. Warm-up is 20 s, the measured window 60 s, idle 30 s. Keep `compose.bench.yaml` in step with the environment names of `compose.yaml`.

`bun bench/seed.ts <api worktree> <output db path> [density] [now ms]` seeds a database. `density` is the number of results per minute per check (default 1, the 864 000 rows above). `now` is the newest timestamp (default `Date.now()`); every row timestamp is computed from it. With density `n > 1`, each check gets `n` results per minute at `now - k*60000 - j*(60000/n)` for `j = 0..n-1`. The `j = 0` rows are the 1x rows. An extra row (`j >= 1`) whose index `k*n + j` is divisible by 97 is `down`, so uptime is not always 100. The last line is `seeded <N> results (check interval <ms> ms, density <n>, now <now ms>)`.

## The cold-read phase

The first reads after an api restart once scanned the whole 30- and 90-day window of every check. Those reads hide in the 20 s warm-up of the load, so they have their own phase. It runs once per round and side, after the stack run, with only the `api` service of `compose.bench.yaml` on a fresh copy of the side's 10x seed (`.bench/seed/<side>/pulse-10x.db`, 20 checks, 30 days, density 10: 8 640 000 rows). `prepareSide` makes the seed once per side with that side's api worktree, so with its own `src/db.ts` and `src/service.ts`. The 1x load, its metrics and its budgets stay comparable.

1. Warm start: `up -d --no-build api`, wait for `/readyz`, one `GET /checks` and one `GET /uptime`. Then wait until the api's CPU time grows by less than 20 ms over 2 s (at most 300 s). A and B follow the same procedure, whether or not they run a backfill.
2. Cold sequential: `docker compose restart api` (SIGTERM). At the first `200` of `/readyz`, read the CPU time, send `GET /checks` and, after it answered, `GET /uptime`, then read the CPU time again: `cold_get_checks_ms`, `cold_get_uptime_ms` and `cold_read_cpu_ms`.
3. Cold concurrent: restart again; at the first `200` of `/readyz` send both at once: `cold_concurrent_ms`.

Both requests must answer `200` within the 30 s client timeout, or the run fails (exit code 2). The phase logs the UTC time of each cold read and the number of today's rows in the seed. The first cold read still builds today's tally from the results, so `cold_read_cpu_ms` still grows with the UTC hour: about 0 rows of today at 00:05 and up to 288 000 at 23:59. The cold `GET /uptime` reuses the tally that the cold `GET /checks` built. Its budget covers a late-day run. Only `cold_read_cpu_ms` gates, because the wall times are noisy.

`bun bench/cold-read.ts --api <worktree> [--seed-with <worktree>] [--density 10] [--limit-ms 400] [--today-rows <n>]` runs steps 1-3 without Docker: it seeds a temp database with this `bench/seed.ts` and the `--seed-with` worktree (default `--api`), runs `bun <api>/src/main.ts` as a child process with the bench checks and tokens, and reads the CPU time from `/proc/<pid>/stat`. It prints one JSON object with the cold numbers, the `/readyz` wall and CPU time of each start, the first reads of the warm start, `utc_start`, `seed_now_ms`, `today_rows` and the rollup log lines. It exits `1` when `cold_get_checks_ms`, `cold_get_uptime_ms` or `cold_concurrent_ms` is at or above `--limit-ms`. `--seed-with` an older worktree gives a file of that schema version: the first start after an upgrade. `--today-rows <n>` adds results of today until the seed holds at least `n` rows since UTC midnight, so a run at any hour can measure the late-day tally: the extra rows are spread evenly from UTC midnight to the seed's `now`, at the locations `sim1` and `sim2` of every check. The output adds `today_rows_target` and `today_rows_added`.

`bun bench/uptime-parity.ts <worktree A> <worktree B> <seed db> <now ms>` compares the uptime answers of two api versions byte for byte: `getUptime()`, `componentsUptime` of two fixed components and the `slo` of every check, with `now` fixed. B is written with no stored days (fill on read), with half of the checks backfilled, after the whole backfill and a restart, and after one late result for a stored day (A gets the same late result). It exits `1` when a B output differs from A's output of the same step and prints the sha256 of each output.

## The end-of-day phase

Reads once re-read all of today's results after every ingest, so they cost more at the end of a UTC day than at its start. The load phase cannot show that: its seed holds about 137 rows of today per check at the nightly time, and a denser seed would make side A queue requests for the whole window. So the end-of-day case has its own phase (`bench/eod.ts`). It runs once per round and side, after the cold-read phase, with only the `api` service in the run directory `.bench/run-eod/<side>`.

- Seed: a copy of the side's 1x load seed. `addTodayRows` (`bench/cold.ts`) adds rows at the locations `sim1` and `sim2` until today holds at least `EOD_TODAY_ROWS` = 518 400 rows: 20 checks x 3 locations x one result per 10 s for a whole day, compressed into the time from UTC midnight to now.
- Near midnight: before 00:10:00 UTC the phase logs `eod: waiting until 00:10 UTC so today's rows fit` and waits. When the UTC day changes between seeding and the last cycle, it logs that and repeats once from seeding. A second change is a harness error.
- Checks file: the bench checks plus two components, `first` (checks 0-9) and `second` (checks 10-19), each with the bench availability target, so `/components` builds an `slo` too.
- Procedure: start the api, wait for `/readyz`, send one warm read of each measured route (`GET /checks`, `/uptime`, `/latency`, `/checks/c0/latency`, `/components`, `/components/uptime`), then wait for the CPU settle of the cold-read phase. Read the CPU time and run `EOD_CYCLES` = 20 cycles. Each cycle sends one `POST /results` as `sim1`; then, for each route in turn, one more accepted `POST /results` (next check) right before that route's `GET`, and records the wall time of the `GET`. So every measured `GET` follows an ingest, and no route is served from a cache that another route filled. Every `POST` must answer `204` and every `GET` `200`. Read the CPU time again.
- Metrics: per route the nearest-rank p95 of its 20 samples (the 19th smallest), reported; `eod_read_cpu_ms`, the CPU time of the cycles with the POSTs, gating. The log holds the UTC time, today's rows and the api `VmRSS`.
- A route that side A lacks (`OPTIONAL_ROUTES`, which also lists `/components` and `/components/uptime` with the commit that added them) is not requested on A, and its metric is `not available on A`.

`bun bench/eod-read.ts --api <worktree> [--seed-with <worktree>] [--today-rows 518400] [--cycles 20] [--checks-limit-ms 392] [--latency-limit-ms 53]` runs the phase without Docker: it seeds a temp 1x database with this `bench/seed.ts`, adds today's rows, runs `bun <api>/src/main.ts` as a child process and reads CPU time and `VmRSS` from `/proc/<pid>`. It prints one JSON object with the seven metrics, the median of each route, `vm_rss_mib`, `utc_start`, `seed_now_ms` and `today_rows`. It exits `1` when `eod_get_checks_ms` or `eod_get_latency_ms` is at or above its limit, and `2` on an error, also when today's rows do not fit before 00:10 UTC.

`bun bench/today-parity.ts <worktree A> <worktree B> <seed db> <now ms>` compares every answer that depends on today, byte for byte. `<seed db>` is a 1x seed from `bun bench/seed.ts <A> <db> 1 <now>`, and `<now>` is at least 10 min after a UTC midnight. Each side gets its own copy with the 518 400 rows of today, a clock and the same inputs. Outputs are written at five steps: the first read; after a fixed ingest sequence (`up`, `degraded`, `down`, a late row, a repeat, a generated sample on an occupied timestamp, a row stamped `now + 30000`); after a restart; with the clock 40 s later; and after one ingest stamped 10 s after the next UTC midnight with the clock then moved to that midnight + 60 s. Each output holds `listChecks()`, `getUptime()`, `getLatency()`, `getCheckLatency` of every HTTP check, `componentsUptime`, `componentsWithState` and `componentBudgets` of the two components. It prints the sha256 of every output and exits `1` when a B output differs from A's.

## Running it

```sh
bun bench/run.ts --a <ref> --b <ref> [--rounds n] [--others-ref <ref>] [--out <dir>]
```

Needs Docker with Compose, `git` and network access to the public pulse repositories. `--a` and `--b` are refs of the api (defaults: `baseline` and `main`). For the other repositories, A is the newest `v*` tag (else the SHA in `bench/baseline.json`) and B is `main`; `--others-ref <ref>` pins all of them to one ref on both sides. A run is 5 rounds per side, alternating A, B, A, B (10 runs), and the result per metric is the median. Plan on 40 minutes: a 5-round run with the cold-read phase took 32 minutes on the hosted runner, about 3 minutes per side and round of it in the cold-read phase. The end-of-day phase adds about 1 minute per round on side A (20 cycles of about 1.6 s CPU, plus seeding and settle) and about 20 s on side B; this is an estimate from local runs, re-measure it on the first hosted run. A local run prints a warning: the numbers are comparable only on one machine.

For an A = B check: `bun bench/run.ts --a <sha> --b <sha> --others-ref main`.

The workspace is `.bench/` (git-ignored). The output is the table (also in `$GITHUB_STEP_SUMMARY`), `table.json` and `samples.json` in `--out` (default `bench-out/`). The workflow takes the same options as the inputs `a`, `b` and `others`. The exit code is `1` on a gating failure and `2` on a harness error (a failed run or a missing metric fails the whole run).

## Reading a failure

One table per service, columns Metric, A, B, Change, Budget, Gating/Reported, Verdict. A failing row names the metric key.

- `FAIL regression`: `B - A > max(A * thresholdPct / 100, floor)`. The defaults are 10 % and the floors `ms` 30, `s` 0.2, `MiB` 3. Improvements never fail.
- `FAIL budget`: B is above the budget of `bench/budgets.json`.
- `reported`: the metric does not gate.
- `not available on A`: side A's api ref predates the commit that added the route (see above). The A column shows `n/a`, the metric is not compared and does not fail.

Look at `samples.json` in the uploaded artifact for the raw values of every round. When a stack run fails, `failure-round<n>-<side>.log` in the artifact holds `docker compose ps -a` and the logs of every container of that stack.

The load generator keeps pooled keep-alive connections. The api closes an idle one after 5 s (Node's `keepAliveTimeout`); a request sent on it at that moment fails with `ECONNRESET` before any response. A GET is then sent once more; a POST is not, because side A can run an api from before the unique key on (check id, location, timestamp), which stores a repeated result twice. Both are counted in the log line `connections closed before a response`. More than 5 in one run fail it, also when they arrive while the last requests drain. If A and B of the same SHA differ, the metric is noisy: widen its floor.

## Changing a budget

`bench/budgets.json` is `{ "<service>": { "<metric>": { "budget", "unit", "gating", "thresholdPct"?, "floor"? } } }`. Change it in a pull request that says why and gives the measured values (A medians). A budget is the measured A median plus about 30 % headroom, rounded up. The `eod_*` budgets are the exception: they come from B medians, because A is the code that the end-of-day change fixed and its numbers are what the budget must keep out. `bench/baseline.json` holds the SHA per repository that A falls back to; bump it the same way. A self-test checks that every metric the harness emits has a budget.

## Self-tests

```sh
bun run bench:selftest
```

The scripts in `bench/selftest/check-*.ts` use `node:assert` and cover the median, the failure rule, the table, the budgets schema, the ref resolution and the closed-connection handling of the load, the seed rows, settle rule and limit check of the cold-read phase, and the p95, midnight wait, limit check, checks file and day-change retry of the end-of-day phase. CI runs them, and checks `docker compose -f bench/compose.bench.yaml config --quiet`.

## Initial budgets

The seven `eod_*` budgets come from three local `bun bench/eod-read.ts` runs of B at 518 400 rows of today: the median p95 per route plus 30 %, rounded up to whole ms (`eod_get_checks_ms` 3 -> 4, `eod_get_uptime_ms` 2 -> 3, `eod_get_latency_ms` 4 -> 6, `eod_get_check_latency_ms` 1 -> 2, `eod_get_components_ms` 3 -> 4, `eod_get_components_uptime_ms` 2 -> 3), and `eod_read_cpu_ms` 420 -> 550. Side A on the same machine took 250, 249, 357, 20, 493 and 252 ms and 32 450 ms of CPU. Re-set them from the B medians of the first hosted A/B run.

The budgets are the median of A over one local A = A run (1 round) plus 30 % headroom, rounded up (CPU seconds to 0.1, with a lower bound of 0.5 s; other units to whole numbers). The two latency budgets come from one local run on 1 M-scale seed data (p95 40.6 ms and 41.8 ms, plus 30 %, rounded up); `rps` of that run was 43 req/s with all five streams, above the older budget of 40, which is left unchanged and only reported. Reported metrics carry their reference value; `rps` is the measured value, not a limit. The floors of `test_cpu_s` for contract (2 s) and config (3 s) are widened because their test suites varied by about 20 % between two runs of the same commit. Re-set the budgets from the first nightly runs.

The four cold-read budgets come from two local `bun bench/cold-read.ts --density 10 --today-rows 288000` runs, the late-day size of today's tally: `cold_get_checks_ms` 152 and 152, `cold_get_uptime_ms` 145 and 143, `cold_read_cpu_ms` 300 and 300, `cold_concurrent_ms` 300 and 293. Each value plus 30 % headroom, rounded up: 200, 190, 390 and 390 ms. That machine matches the hosted runner: at 126 540 rows of today it gave 48, 42, 90 and 90 ms, against the B medians 46, 42, 100 and 89 ms of a 5-round A/B run on the hosted runner at 09:44-10:10 UTC with 116 320 rows of today (A medians 3495, 3551, 7090 and 3598 ms). The cost grows faster than the row count, so scaling a morning median to 288 000 rows underestimates it. `cold_read_cpu_ms` keeps the default floor of 30 ms; widen it when an A = B run shows more noise.
