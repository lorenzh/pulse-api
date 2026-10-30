# Performance bench

`bench/` measures CPU time and memory of every pulse service under a fixed load and compares two versions (A and B) in one job. A nightly GitHub workflow (`.github/workflows/bench.yml`, 02:17 UTC, `main` only) runs it. It is not part of `bun test`.

## What is measured

| Metric key            | Meaning                                                     | Services                   | Gates |
| --------------------- | ----------------------------------------------------------- | -------------------------- | ----- |
| `startup_cpu_ms`      | CPU time (utime + stime) at the first `200` of `/readyz`    | api, probe, status, notify | yes   |
| `load_cpu_s`          | CPU time during the 60 s measured load window               | api, probe, status, notify | yes   |
| `idle_rss_mib`        | `VmRSS` after startup and 30 s without requests             | api, probe, status, notify | yes   |
| `peak_rss_mib`        | `VmHWM` at the end of the load phase                        | api, probe, status, notify | yes   |
| `test_cpu_s`          | CPU time of `bun run test` in the repository                | all seven repositories     | yes   |
| `build_cpu_s`         | CPU time of `bun run build`                                 | contract, kit              | yes   |
| `startup_wall_ms`     | Wall time from `compose up` to the first `200` of `/readyz` | api, probe, status, notify | no    |
| `p95_get_checks_ms`   | p95 latency of `GET /checks` under load                     | api                        | no    |
| `p95_post_results_ms` | p95 latency of `POST /results` under load                   | api                        | no    |
| `rps`                 | Requests per second that were served in the window          | api                        | no    |
| `image_mb`            | `docker image inspect` size                                 | api, probe, status, notify | no    |

Only CPU time and memory gate. Hosted runners are too noisy for wall-clock numbers, so latency, throughput and wall-clock startup are only reported. Image size is deterministic, but gating it is not a decision that was made, so it is reported too.

Process numbers are read from inside the container: each service is PID 1, so `docker exec <container> cat /proc/1/stat` and `/proc/1/status` give its own CPU time and memory, without healthcheck or exec processes and without page cache. CPU time has a resolution of 10 ms.

## The load

The constants are in `bench/load.ts`. The api database is seeded with 20 checks and 30 days of 1-minute results (864 000 rows) by `bench/seed.ts`, using the `src/db.ts` of the version under test. Three simulated probes send together 30 `POST /results` per second, round robin over the checks. Besides that, 10 `GET /checks` and 1 `GET /uptime` per second. The real probe, status page and notify run as configured in `bench/compose.bench.yaml`; the probe checks the 20 checks every 10 s against a trivial `bench-target` container. Warm-up is 20 s, the measured window 60 s, idle 30 s. Keep `compose.bench.yaml` in step with the environment names of `compose.yaml`.

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

Look at `samples.json` in the uploaded artifact for the raw values of every round. When a stack run fails, `failure-round<n>-<side>.log` in the artifact holds `docker compose ps -a` and the logs of every container of that stack.

The load generator keeps pooled keep-alive connections. The api closes an idle one after 5 s (Node's `keepAliveTimeout`); a request sent on it at that moment fails with `ECONNRESET` before any response. A GET is then sent once more; a POST is not, because the api stores a repeated result twice (results have no unique key). Both are counted in the log line `connections closed before a response`. More than 5 in one run fail it. If A and B of the same SHA differ, the metric is noisy: widen its floor.

## Changing a budget

`bench/budgets.json` is `{ "<service>": { "<metric>": { "budget", "unit", "gating", "thresholdPct"?, "floor"? } } }`. Change it in a pull request that says why and gives the measured values (A medians). A budget is the measured A median plus about 30 % headroom, rounded up. `bench/baseline.json` holds the SHA per repository that A falls back to; bump it the same way. A self-test checks that every metric the harness emits has a budget.

## Self-tests

```sh
bun run bench:selftest
```

The scripts in `bench/selftest/check-*.ts` use `node:assert` and cover the median, the failure rule, the table, the budgets schema, the ref resolution and the closed-connection handling of the load. CI runs them, and checks `docker compose -f bench/compose.bench.yaml config --quiet`.

## Initial budgets

The budgets are the median of A over one local A = A run (1 round) plus 30 % headroom, rounded up (CPU seconds to 0.1, with a lower bound of 0.5 s; other units to whole numbers). Reported metrics carry their reference value; `rps` is the measured value, not a limit. The floors of `test_cpu_s` for contract (2 s) and config (3 s) are widened because their test suites varied by about 20 % between two runs of the same commit. Re-set the budgets from the first nightly runs.
