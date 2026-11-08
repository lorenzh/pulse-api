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

The constants are in `bench/load.ts`. The api database is seeded with 20 checks and 30 days of 1-minute results (864 000 rows) by `bench/seed.ts`, using the `src/db.ts` of the version under test. Three simulated probes send together 30 `POST /results` per second, round robin over the checks. Besides that, 10 `GET /checks`, 1 `GET /uptime`, 1 `GET /latency` and 1 `GET /checks/:id/latency` per second. Every bench check has an `availabilityTarget` (99.5), so `GET /checks` builds an `slo` for each. Before the load, the harness checks for each latency route whether side A's api ref contains the commit that added it (`OPTIONAL_ROUTES` in `bench/load.ts`, `git merge-base --is-ancestor`). A route whose commit A does not contain is not requested on A, and its p95 metric is marked `not available on A`. Every route that is requested must answer `200` on both sides: a `404` from a route that A has, or from side B, fails the run. The real probe, status page and notify run as configured in `bench/compose.bench.yaml`; the probe checks the 20 checks every 10 s against a trivial `bench-target` container. Warm-up is 20 s, the measured window 60 s, idle 30 s. Keep `compose.bench.yaml` in step with the environment names of pulse-deploy's [`common/services.yaml`](https://github.com/lorenzh/pulse-deploy/blob/main/common/services.yaml).

`bun bench/seed.ts <api worktree> <output db path> [density] [now ms]` seeds a database. `density` is the number of results per minute per check (default 1, the 864 000 rows above). `now` is the newest timestamp (default `Date.now()`); every row timestamp is computed from it. With density `n > 1`, each check gets `n` results per minute at `now - k*60000 - j*(60000/n)` for `j = 0..n-1`. The `j = 0` rows are the 1x rows. An extra row (`j >= 1`) whose index `k*n + j` is divisible by 97 is `down`, so uptime is not always 100. The last line is `seeded <N> results (check interval <ms> ms, density <n>, now <now ms>)`.

## The cold-read phase

The first reads after an api restart once scanned the whole 30- and 90-day window of every check. Those reads hide in the 20 s warm-up of the load, so they have their own phase. It runs once per round and side, after the stack run, with only the `api` service of `compose.bench.yaml` on a fresh copy of the side's 10x seed (`.bench/<id>/seed/<side>/pulse-10x.db`, 20 checks, 30 days, density 10: 8 640 000 rows). `prepareSide` makes the seed once per side with that side's api worktree, so with its own `src/db.ts` and `src/service.ts`. The 1x load, its metrics and its budgets stay comparable.

1. Warm start: `up -d --no-build api`, wait for `/readyz`, one `GET /checks` and one `GET /uptime`. Then wait until the api's CPU time grows by less than 20 ms over 2 s (at most 300 s). A and B follow the same procedure, whether or not they run a backfill.
2. Cold sequential: `docker compose restart api` (SIGTERM). At the first `200` of `/readyz`, read the CPU time, send `GET /checks` and, after it answered, `GET /uptime`, then read the CPU time again: `cold_get_checks_ms`, `cold_get_uptime_ms` and `cold_read_cpu_ms`.
3. Cold concurrent: restart again; at the first `200` of `/readyz` send both at once: `cold_concurrent_ms`.

Both requests must answer `200` within the 30 s client timeout, or the run fails (exit code 2). The phase logs the UTC time of each cold read and the number of today's rows in the seed. The first cold read still builds today's tally from the results, so `cold_read_cpu_ms` still grows with the UTC hour: about 0 rows of today at 00:05 and up to 288 000 at 23:59. The cold `GET /uptime` reuses the tally that the cold `GET /checks` built. Its budget covers a late-day run. Only `cold_read_cpu_ms` gates, because the wall times are noisy.

`bun bench/cold-read.ts --api <worktree> [--seed-with <worktree>] [--density 10] [--limit-ms 400] [--today-rows <n>]` runs steps 1-3 without Docker: it seeds a temp database with this `bench/seed.ts` and the `--seed-with` worktree (default `--api`), runs `bun <api>/src/main.ts` as a child process with the bench checks and tokens, and reads the CPU time from `/proc/<pid>/stat`. It prints one JSON object with the cold numbers, the `/readyz` wall and CPU time of each start, the first reads of the warm start, `utc_start`, `seed_now_ms`, `today_rows` and the rollup log lines. It exits `1` when `cold_get_checks_ms`, `cold_get_uptime_ms` or `cold_concurrent_ms` is at or above `--limit-ms`. `--seed-with` an older worktree gives a file of that schema version: the first start after an upgrade. `--today-rows <n>` adds results of today until the seed holds at least `n` rows since UTC midnight, so a run at any hour can measure the late-day tally: the extra rows are spread evenly from UTC midnight to the seed's `now`, at the locations `sim1` and `sim2` of every check. The output adds `today_rows_target` and `today_rows_added`.

`bun bench/uptime-parity.ts <worktree A> <worktree B> <seed db> <now ms>` compares the uptime answers of two api versions byte for byte: `getUptime()`, `componentsUptime` of two fixed components and the `slo` of every check, with `now` fixed. B is written with no stored days (fill on read), with half of the checks backfilled, after the whole backfill and a restart, and after one late result for a stored day (A gets the same late result). It exits `1` when a B output differs from A's output of the same step and prints the sha256 of each output.

## The end-of-day phase

Reads once re-read all of today's results after every ingest, so they cost more at the end of a UTC day than at its start. The load phase cannot show that: its seed holds about 137 rows of today per check at the nightly time, and a denser seed would make side A queue requests for the whole window. So the end-of-day case has its own phase (`bench/eod.ts`). It runs once per round and side, after the cold-read phase, with only the `api` service in the run directory `.bench/<id>/run-eod/<side>`.

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
bun bench/run.ts --a <ref> --b <ref> [--rounds n] [--others-ref <ref>] [--b-ref <repo>=<ref>]...
  [--simulate-services | --service-tokens] [--expect-report status|notify]... [--out <dir>]
```

Needs Docker with Compose, `git` and network access to the public pulse repositories. `--a` and `--b` are refs of the api (defaults: `baseline` and `main`). For the other repositories, A is the newest `v*` tag (else the SHA in `bench/baseline.json`) and B is `main`; `--others-ref <ref>` pins all of them to one ref on both sides. A run is 5 rounds per side, alternating A, B, A, B (10 runs), and the result per metric is the median. Plan on 40 minutes: a 5-round run with the cold-read phase took 32 minutes on the hosted runner, about 3 minutes per side and round of it in the cold-read phase. With the end-of-day phase, a 5-round run took 35 minutes on the hosted runner; the phase takes about 40 s per round on side A (20 cycles of about 1.6 s CPU, plus seeding and settle) and about 10 s on side B. A local run prints a warning: the numbers are comparable only on one machine.

For an A = B check: `bun bench/run.ts --a <sha> --b <sha> --others-ref main`.

### Controlled refs

Before the first round the harness resolves every ref of both sides to a full commit SHA, once per repository and ref (`git fetch origin <ref>`, then `git rev-parse FETCH_HEAD^{commit}`). Every checkout uses that SHA, so a `main` that moves during the run changes nothing. After each checkout it compares `git rev-parse HEAD` of the worktree with the resolved SHA. It logs one line per repository, `ref <repo> a=<sha> b=<sha>`. With `--others-ref`, every repository but the api and the `--b-ref` ones must have the same SHA on both sides. A difference is exit `2` with `ref mismatch: <repo> <side>`.

`--b-ref <repo>=<ref>` sets only the B side of one repository other than the api; A keeps the `--others-ref` ref. It may repeat. The api, an unknown or repeated repository, and `--b-ref` without `--others-ref` are usage errors (exit `2`).

### Runtime configuration traffic

The api gets a fixed bench admin token (`PULSE_API_ADMIN_TOKENS_FILE`, `BENCH_ADMIN_TOKEN` in `bench/runtime-fixture.ts`). Without the next two options no token is created, `BENCH_STATUS_TOKEN_FILE` and `BENCH_NOTIFY_TOKEN_FILE` stay empty, and the run is unchanged.

With either option, after the api of a side is ready and before probe, status and notify start, the harness creates a `status` and a `notify` token, PUTs one status settings document (`name`, `showLatency: false`) and creates five webhook channels (`urlEnv: PULSE_NOTIFY_SECRET_BENCH`, `checks: ["c0"]`). Any other answer than `201` (or `200` for the settings) is exit `2`.

- `--simulate-services`: the real status and notify get no token. During the 60 s window the harness sends their traffic itself: `GET /service/status/settings` and `GET /service/notify/channels` at 0, 15, 30 and 45 s, `POST /service/notify/resends/claim` every 5 s from 0 to 55 s, and one `PUT /service/status/report` and one `PUT /service/notify/report` at 0 s and after the last load request. A late timer only delays a request, it never drops one. Every answer must be `200`, `204` or `304` and valid, and the counts must be exactly 4, 4, 12, 2 and 2, else exit `2` `service traffic not observed on <side>`. The log line is `service traffic (<side>): 4 status reads, 4 channel reads, 12 claims, 2 status reports, 2 notify reports`. On B the token creation must give `201`. On A only the answer of an api without the new scopes turns the simulation off: `400` with a JSON string `error` that starts with `token.scopes[0]: must be one of ` and does not list the requested scope in quotes. The run then logs `service traffic: not available on a`. Every other answer is exit `2` `service tokens: <status> on <side>`.
- `--service-tokens`: `201` is required on both sides. The secrets go to `<run dir>/service-tokens/{status,notify}` (mode 0644), mounted read-only at `/service-tokens`, and the real containers get `PULSE_STATUS_API_TOKEN_FILE` and `PULSE_NOTIFY_API_TOKEN_FILE`. The two options exclude each other (exit `2`).
- `--expect-report status|notify` (repeatable): after the window the harness reads `GET /admin/status/settings` or `GET /admin/notify/channels`. On B `service.state` must be `fresh` and `service.report.appliedRevision` must equal `revision`, else exit `2` `<service> report not observed on b`. On A the state is only logged.

Commands of the runtime configuration feature: before the api merges, `bun bench/run.ts --a <api main SHA> --b <api branch SHA> --others-ref main --simulate-services`; after it merged, for status (or notify), `bun bench/run.ts --a <api main SHA> --b <api main SHA> --others-ref main --b-ref status=<branch SHA> --service-tokens --expect-report status`.

### Run identity and parallel runs

Each `bun bench/run.ts` makes a random invocation id of 12 lowercase hex characters (6 bytes of `node:crypto`) and logs `invocation <id>`. Every name of the run carries it: the Compose projects `pulse-bench-<id>-<side>` (and so the containers `pulse-bench-<id>-<side>-<service>`), the eight image tags `pulse-bench-<id>-<side>-<service>`, and the workspace `.bench/<id>/` (git-ignored) with the run's own clones, worktrees, seeds and run directories. At the end of a run, also after an error, the harness confirms that both projects have no container left, then removes the eight images (the shared `oven/bun` image stays) and `.bench/<id>/`. If a project still has containers, it removes nothing and logs `cleanup skipped: containers of <project> remain; kept .bench/<id> and its images`. A cleanup failure is logged and changes neither the error nor the exit code. There is no machine-wide lock: two runs on one machine run their phases at the same time. Give each run its own `--out` directory, for example:

```sh
bun bench/run.ts --a <sha> --b <sha> --others-ref main --out /tmp/bench-1 &
bun bench/run.ts --a <sha> --b <sha> --others-ref main --out /tmp/bench-2 &
wait
```

### Host ports

Docker no longer picks the host ports. The harness takes them from `20000-29999` in blocks of five: block `k` (0-1999) has the guard port `20000 + 5k` and the api, probe, status and notify ports at `+1` to `+4`. At start it reads the ephemeral range from `/proc/sys/net/ipv4/ip_local_port_range` once and keeps only blocks whose five ports all lie outside it. An unreadable or malformed file is exit `2`; there is no default range, and the harness never changes a sysctl. If no block is left, the run stops before any clone with `no bench port block in 20000-29999 outside the ephemeral range <low>-<high>` (exit `2`).

For each phase (`load`, `cold`, `eod`) of a side and round, the harness reserves a block: it listens on the guard port at `127.0.0.1` and holds that listener until the phase's teardown is confirmed, so another run (or this one) skips the block. It then listens on the four service ports and closes them at once; if one is taken, it frees the guard and tries the next block. The scan starts at a random block and wraps around, trying each block once. If none is free: `no free bench port block in 20000-29999` (exit `2`). The fixed ports also stay the same across the `restart api` of the cold-read phase.

A Docker port bind failure (a `docker` command whose stderr contains `address already in use` or `port is already allocated`, also in a `cause`) gets one more attempt of that phase with a new block that is not the failed one, on a fresh run directory and fresh seed data; the load phase makes its runtime tokens again. The log says `bind retry: <phase> on <side>: host port in use, retrying once with new ports`, and only the second attempt's values go into the samples. Every other error (other Docker errors, readiness timeouts, request failures, allocation errors) is not retried. A second bind failure ends the run with `host port bind failed twice: <phase> on <side> (ports <api>,<probe>,<status>,<notify>): <stderr line>` (exit `2`, no `table.*` and no `samples.json`).

After every attempt the harness confirms the teardown of the phase's project: `docker ps -a -q --filter label=com.docker.compose.project=<project>` must be empty, after at most one more `docker compose -p <project> down -v --remove-orphans -t 5`. Only then does it release the guard, remove the run directory and retry, or go on. If containers remain, it logs `teardown not confirmed: <phase> on <side> (project <project>): <reason>`, keeps the guard and the run directory, and stops with exit `2`: after a bind failure with `host port bind failed, retry skipped because teardown was not confirmed: ...`, after a successful attempt with the `teardown not confirmed` error, and after any other failure with that failure's own error. The end-of-day phase also confirms the teardown before every seed, so its reseed after a UTC day change never deletes the run directory under a running container.

When attempt 1 fails and a retry follows, its stack dump is kept as `failure-round<n>-<side>-<phase>-attempt1.log` in `--out`. Every other failure writes `failure-round<n>-<side>.log` as before.

### Output

The output is the table (also in `$GITHUB_STEP_SUMMARY`), `table.json` and `samples.json` in `--out` (default `bench-out/`). The workflow takes the same options as the inputs `a`, `b` and `others`. The exit code is `1` on a gating failure and `2` on a harness error (a failed run or a missing metric fails the whole run).

## Reading a failure

One table per service, columns Metric, A, B, Change, Budget, Gating/Reported, Verdict. A failing row names the metric key.

- `FAIL regression`: `B - A > max(A * thresholdPct / 100, floor)`. The defaults are 10 % and the floors `ms` 30, `s` 0.2, `MiB` 3. Improvements never fail.
- `FAIL budget`: B is above the budget of `bench/budgets.json`.
- `reported`: the metric does not gate.
- `not available on A`: side A's api ref predates the commit that added the route (see above). The A column shows `n/a`, the metric is not compared and does not fail.

Look at `samples.json` in the uploaded artifact for the raw values of every round. When a stack run fails, `failure-round<n>-<side>.log` in the artifact holds `docker compose ps -a` and the logs of every container of that stack.

The load generator keeps pooled keep-alive connections. The api closes an idle one after 5 s (Node's `keepAliveTimeout`); a request sent on it at that moment fails with `ECONNRESET` before any response. A GET is then sent once more; a POST is not, because side A can run an api from before the unique key on (check id, location, timestamp), which stores a repeated result twice. Both are counted in the log line `connections closed before a response`. More than 5 in one run fail it, also when they arrive while the last requests drain. If A and B of the same SHA differ, the metric is noisy: widen its floor.

A command of the harness that exits non-zero throws `CommandExitError`. Its message shows the command, the exit code and the last 500 characters of stderr; the error object keeps the full stderr, so a line near the start (for example a Docker `Bind for ... failed: port is already allocated`) is not lost. The full stderr is never printed. The bench classifies a bind failure by that full stderr.

A host port bind failure is retried once per phase (see [Host ports](#host-ports)); the first attempt's dump is then `failure-round<n>-<side>-<phase>-attempt1.log`. `bench: host port bind failed twice: ...` means the retry hit a taken port too: run again, or look for a process that holds many ports in `20000-29999`. `teardown not confirmed: ...` and `host port bind failed, retry skipped because teardown was not confirmed: ...` mean that `compose down` left containers behind. The same `teardown not confirmed: eod on <side> ...` error stops the end-of-day phase when the UTC day changed during it and the teardown before the reseed is not confirmed; the reseed is skipped and the run directory is kept. These errors do not decide what stays: the cleanup at the end of the run checks both projects again. If no container is left then, it removes the eight images and `.bench/<id>/` as after any run, also after a `retry skipped` or `teardown not confirmed` error. Only when containers still remain at that final check does the run keep `.bench/<id>/` and its images (`cleanup skipped: ...`); remove them by hand after `docker compose -p <project> down -v`. No bench port block outside the ephemeral range, or no free one, is also exit `2`.

## Changing a budget

`bench/budgets.json` is `{ "<service>": { "<metric>": { "budget", "unit", "gating", "thresholdPct"?, "floor"? } } }`. Change it in a pull request that says why and gives the measured values (A medians). A budget is the measured A median plus about 30 % headroom, rounded up. The `eod_*` budgets are the exception: they come from B medians, because A is the code that the end-of-day change fixed and its numbers are what the budget must keep out. `bench/baseline.json` holds the SHA per repository that A falls back to; bump it the same way. A self-test checks that every metric the harness emits has a budget.

## Self-tests

```sh
bun run bench:selftest
```

The scripts in `bench/selftest/check-*.ts` use `node:assert` and cover the median, the failure rule, the table, the budgets schema, the ref resolution, `--b-ref` and the ref checks, the service token answers, fixture and report check, the simulated traffic schedule and counts, and the closed-connection handling of the load, the seed rows, settle rule and limit check of the cold-read phase, and the p95, midnight wait, limit check, checks file and day-change retry of the end-of-day phase. `check-command-error.ts` runs `sh` through `runChecked` and checks that the `CommandExitError` keeps the full stderr while its message keeps only the last 500 characters. `check-ports.ts` checks the range parsing, the candidate blocks for literal ephemeral ranges, the guard and port checks, the random start with wrap-around, the excluded block and the exhaustion error. `check-bind-retry.ts` checks which errors retry, the order allocate, remove, attempt, confirm, release, the `failed twice` and `retry skipped` errors, the forced teardown failures that keep the guard, and the `-attempt1.log` name. It also drives the real `runEodPhase` with a fake clock: a UTC day change with two confirmed teardowns seeds twice, a failed confirmation before the reseed throws `TeardownError` after one seed, a failed first confirmation seeds never, and that `TeardownError` is not retried as a bind failure. `check-invocation.ts` checks the id, project, image and port names, the workspace path checks, `confirmTeardown` with a fake `docker`, and a cleanup that removes only the run's own images and workspace and nothing while containers remain. `check-side-round.ts` drives `measureStack` with fake phases: a bind failure in each phase recovers with new ports, two fail with `PortBindError`, a timeout is not retried, an unconfirmed teardown stops the side, every metric gets one value, and the end-of-day phase gets a teardown check for its own project. CI runs them, and checks `docker compose -f bench/compose.bench.yaml config --quiet`.

## Initial budgets

The seven `eod_*` budgets come from the B medians of a 5-round hosted A/B run (A `21e7bdc`, at 19:47-20:17 UTC with 518 400 rows of today): the median p95 per route plus 30 %, rounded up to whole ms (`eod_get_checks_ms` 5 -> 7, `eod_get_uptime_ms` 2 -> 3, `eod_get_latency_ms` 5 -> 7, `eod_get_check_latency_ms` 1 -> 2, `eod_get_components_ms` 3 -> 4, `eod_get_components_uptime_ms` 2 -> 3), and `eod_read_cpu_ms` 460 -> 598. The A medians of that run were 254, 253, 355, 20, 501 and 253 ms and 33 130 ms of CPU.

The budgets are the median of A over one local A = A run (1 round) plus 30 % headroom, rounded up (CPU seconds to 0.1, with a lower bound of 0.5 s; other units to whole numbers). The two latency budgets come from one local run on 1 M-scale seed data (p95 40.6 ms and 41.8 ms, plus 30 %, rounded up); `rps` of that run was 43 req/s with all five streams, above the older budget of 40, which is left unchanged and only reported. Reported metrics carry their reference value; `rps` is the measured value, not a limit. The floors of `test_cpu_s` for contract (2 s) and config (3 s) are widened because their test suites varied by about 20 % between two runs of the same commit. Re-set the budgets from the first nightly runs.

The four cold-read budgets come from two local `bun bench/cold-read.ts --density 10 --today-rows 288000` runs, the late-day size of today's tally: `cold_get_checks_ms` 152 and 152, `cold_get_uptime_ms` 145 and 143, `cold_read_cpu_ms` 300 and 300, `cold_concurrent_ms` 300 and 293. Each value plus 30 % headroom, rounded up: 200, 190, 390 and 390 ms. That machine matches the hosted runner: at 126 540 rows of today it gave 48, 42, 90 and 90 ms, against the B medians 46, 42, 100 and 89 ms of a 5-round A/B run on the hosted runner at 09:44-10:10 UTC with 116 320 rows of today (A medians 3495, 3551, 7090 and 3598 ms). The cost grows faster than the row count, so scaling a morning median to 288 000 rows underestimates it. `cold_read_cpu_ms` keeps the default floor of 30 ms; widen it when an A = B run shows more noise.

### Temporary test floors

The `test_cpu_s` values of status come from the medians (3rd smallest of five samples) of hosted run R1, https://github.com/lorenzh/pulse-api/actions/runs/41508721559. The api and notify values come from the spread over several hosted runs of the same code, by the owner decision in https://github.com/lorenzh/pulse-meta/issues/654: floor = ceil0.1(mean(B - A) + 2.8 × sd(B - A)) and budget = ceil0.1(mean B + 2.8 × sd B). A is `v0.1.0` of each service. B is api main `e1153f9` with #617 (the same code as `90f6055`), and the main of the other repositories. `ceil0.1(x)` rounds up to 0.1 s.

- notify: run R, https://github.com/lorenzh/pulse-api/actions/runs/41578638886, A `v0.1.0` `c090a07`, B main `757e78f` with the SQLite ledger (#41): A 2.013 s, B 3.095 s, B - A 1.082 s. The spread comes from the five runs at `3a0b4c8` (the same code), sd(B - A) about 0.145 s. The A side is noisy, likely through the RSA-2048 test key of `v0.1.0`. The floor is ceil0.1(1.082 + 2.8 × 0.145) = ceil0.1(1.488) = 1.5 s. The budget is ceil0.1(3.095 + 2.8 × sd B), with sd B from the same five runs, = 3.4 s (the owner decision). Both values are temporary.
- api: four hosted runs of the same B code: R1 41508721559, R2 41517811504, main 41525755478 and R 41578638886. B medians 5.042, 4.985, 5.167 and 5.305 s (mean 5.125, sd 0.142); B - A 1.173, 1.299, 1.333 and 1.362 s (mean 1.292, sd 0.083). The floor is ceil0.1(1.292 + 2.8 × 0.083) = ceil0.1(1.524) = 1.6 s. The budget is ceil0.1(5.125 + 2.8 × 0.142) = ceil0.1(5.523) = 5.6 s. The earlier values 5.2 and 1.4 failed about a third of the nightlies. The floor of 1.6 s stays. The budget of 5.6 s went stale: main's test suite grew, so the nightlies failed it. By the owner decision in https://github.com/lorenzh/pulse-meta/issues/761 (option B), the budget is now ceil0.1(max B × 1.1) over three hosted runs with a = b = api main `4b3e9b1dcce5f4e362c6bc1f529375181fb49f9a` and others = main: https://github.com/lorenzh/pulse-api/actions/runs/42239659031 (B 8.152414 s), https://github.com/lorenzh/pulse-api/actions/runs/42245238740 (B 8.32221 s) and https://github.com/lorenzh/pulse-api/actions/runs/42251206678 (B 5.383386 s). The highest B is 8.32221 s, so the budget is ceil0.1(8.32221 × 1.1) = ceil0.1(9.154431) = 9.2 s. This is an exception to the usual 30 percent rule. Both values are temporary.
- status: A 2.611 s, B 2.666 s, so B - A is 0.055 s, below the noise bound max(A × 0.1, 0.2) - 0.05 = 0.211 s. The budget is a permanent reset to ceil0.1(A × 1.3) = ceil0.1(3.394) = 3.4 s, because `v0.1.0` already exceeds the old 2.4 s. It has no floor.

Release tags are an owner decision; this change makes none. The first api pull request after the next `v*` tag of notify or api removes that repository's floor and resets its budget to ceil0.1(new A × 1.3).
