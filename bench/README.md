# Performance bench

`bench/` measures CPU time and memory of every pulse service under a fixed load and compares two versions (A and B) in one job. A nightly GitHub workflow (`.github/workflows/bench.yml`, 02:17 UTC, `main` only) runs it. It is not part of `bun test`.

## What is measured

| Metric key                 | Meaning                                                        | Services                   | Gates |
| -------------------------- | -------------------------------------------------------------- | -------------------------- | ----- |
| `startup_cpu_ms`           | CPU time (utime + stime) at the first `200` of `/readyz`       | api, probe, status, notify | yes   |
| `load_cpu_s`               | CPU time during the 60 s measured load window                  | api, probe, status, notify | yes   |
| `idle_rss_mib`             | `VmRSS` after startup and 30 s without requests                | api, probe, status, notify | yes   |
| `peak_rss_mib`             | `VmHWM` at the end of the load phase                           | api, probe, status, notify | yes   |
| `test_cpu_s`               | CPU time of `bun run test` in the repository                   | all seven repositories     | yes   |
| `build_cpu_s`              | CPU time of `bun run build`                                    | contract, kit              | yes   |
| `startup_wall_ms`          | Wall time from `compose up` to the first `200` of `/readyz`    | api, probe, status, notify | no    |
| `p95_get_checks_ms`        | p95 latency of `GET /checks` under load                        | api                        | no    |
| `p95_post_results_ms`      | p95 latency of `POST /results` under load                      | api                        | no    |
| `p95_get_latency_ms`       | p95 latency of `GET /latency` under load                       | api                        | no    |
| `p95_get_check_latency_ms` | p95 latency of `GET /checks/:id/latency` under load            | api                        | no    |
| `rps`                      | Requests per second of all five streams in the window          | api                        | no    |
| `image_mb`                 | `docker image inspect` size                                    | api, probe, status, notify | no    |
| `cold_get_checks_ms`       | Wall time of the first `GET /checks` after a restart, 10x seed | api                        | no    |
| `cold_get_uptime_ms`       | Wall time of the `GET /uptime` right after it                  | api                        | no    |
| `cold_read_cpu_ms`         | API CPU time of those two reads                                | api                        | yes   |
| `cold_concurrent_ms`       | Wall time until both answered, sent at once after a restart    | api                        | no    |

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

Both requests must answer `200` within the 30 s client timeout, or the run fails (exit code 2). The phase logs the UTC time of each cold read and the number of today's rows in the seed. Today is still computed from the results at every read, so `cold_read_cpu_ms` grows with the UTC hour: about 0 rows of today at 00:05 and up to 288 000 at 23:59. Its budget covers a late-day run. Only `cold_read_cpu_ms` gates, because the wall times are noisy.

`bun bench/cold-read.ts --api <worktree> [--seed-with <worktree>] [--density 10] [--limit-ms 400]` runs steps 1-3 without Docker: it seeds a temp database with this `bench/seed.ts` and the `--seed-with` worktree (default `--api`), runs `bun <api>/src/main.ts` as a child process with the bench checks and tokens, and reads the CPU time from `/proc/<pid>/stat`. It prints one JSON object with the cold numbers, the `/readyz` wall and CPU time of each start, the first reads of the warm start, `utc_start`, `seed_now_ms`, `today_rows` and the rollup log lines. It exits `1` when `cold_get_checks_ms`, `cold_get_uptime_ms` or `cold_concurrent_ms` is at or above `--limit-ms`. `--seed-with` an older worktree gives a file of that schema version: the first start after an upgrade.

`bun bench/uptime-parity.ts <worktree A> <worktree B> <seed db> <now ms>` compares the uptime answers of two api versions byte for byte: `getUptime()`, `componentsUptime` of two fixed components and the `slo` of every check, with `now` fixed. B is written with no stored days (fill on read), with half of the checks backfilled, after the whole backfill and a restart, and after one late result for a stored day (A gets the same late result). It exits `1` when a B output differs from A's output of the same step and prints the sha256 of each output.

## Running it

```sh
bun bench/run.ts --a <ref> --b <ref> [--rounds n] [--others-ref <ref>] [--out <dir>]
```

Needs Docker with Compose, `git` and network access to the public pulse repositories. `--a` and `--b` are refs of the api (defaults: `baseline` and `main`). For the other repositories, A is the newest `v*` tag (else the SHA in `bench/baseline.json`) and B is `main`; `--others-ref <ref>` pins all of them to one ref on both sides. A run is 5 rounds per side, alternating A, B, A, B (10 runs), and the result per metric is the median. Plan on 35 minutes. A local run prints a warning: the numbers are comparable only on one machine.

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

`bench/budgets.json` is `{ "<service>": { "<metric>": { "budget", "unit", "gating", "thresholdPct"?, "floor"? } } }`. Change it in a pull request that says why and gives the measured values (A medians). A budget is the measured A median plus about 30 % headroom, rounded up. `bench/baseline.json` holds the SHA per repository that A falls back to; bump it the same way. A self-test checks that every metric the harness emits has a budget.

## Self-tests

```sh
bun run bench:selftest
```

The scripts in `bench/selftest/check-*.ts` use `node:assert` and cover the median, the failure rule, the table, the budgets schema, the ref resolution and the closed-connection handling of the load, and the seed rows, settle rule and limit check of the cold-read phase. CI runs them, and checks `docker compose -f bench/compose.bench.yaml config --quiet`.

## Initial budgets

The budgets are the median of A over one local A = A run (1 round) plus 30 % headroom, rounded up (CPU seconds to 0.1, with a lower bound of 0.5 s; other units to whole numbers). The two latency budgets come from one local run on 1 M-scale seed data (p95 40.6 ms and 41.8 ms, plus 30 %, rounded up); `rps` of that run was 43 req/s with all five streams, above the older budget of 40, which is left unchanged and only reported. Reported metrics carry their reference value; `rps` is the measured value, not a limit. The floors of `test_cpu_s` for contract (2 s) and config (3 s) are widened because their test suites varied by about 20 % between two runs of the same commit. Re-set the budgets from the first nightly runs.
