# Development

This page holds what is specific to pulse-api. For how the repositories fit together and how a change goes from spec to pull request, see [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). The rules for code and tests are in [AGENTS.md](../AGENTS.md).

## Run

You need Bun 1.4.0.

```sh
bun install --frozen-lockfile
cp checks.example.json checks.json   # replace the heartbeat secret of nightly-backup, or remove that check
cp tokens.example.json tokens.json   # edit the tokens first
bun start
```

`bun install` also installs the Lefthook pre-commit hook. Tests use a database in a `mkdtemp` directory, never `./pulse.db`.

## Code layout

| File                      | Job                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `src/main.ts`             | Reads the environment, wires the parts and starts the server.                            |
| `src/server.ts`           | HTTP routes, request validation and error mapping.                                       |
| `src/service.ts`          | All SQL, row mapping to contract types, quorum evaluation.                               |
| `src/state.ts`            | Pure rules: `applyResult` and `quorumStatus`.                                            |
| `src/db.ts`               | Schema (current version only).                                                           |
| `src/config.ts`           | Parsing of the checks file, the maintenance windows, the components and the tokens file. |
| `src/tokens.ts`           | Token rules and bearer authentication.                                                   |
| `src/retention.ts`        | Retention setting and the hourly cleanup.                                                |
| `src/location-silence.ts` | The `PULSE_LOCATION_SILENT_MS` setting.                                                  |
| `src/heartbeat.ts`        | The evaluator that writes `down` for heartbeat checks without a ping.                    |

Types come from `@lorenzh/pulse-contract` (a Git dependency pinned to a full commit SHA). Import them with `import type` only.

## Test

```sh
bun run check                     # lint, typecheck and tests, as CI does
bun test src/state.test.ts        # one file
bun test --test-name-pattern "<text>"
```

`bun test` fails below 80 % line coverage. Tests sit next to the code as `src/<module>.test.ts`. Each service has a test that starts its real server on port `0` and drives it over HTTP. Write the failing test first. A change to an endpoint or a response shape gets such a test, typed by the contract.

## Performance bench

`bench/` measures CPU time and memory of api, probe, status and notify under a fixed load, and the test and build CPU time of all seven repositories. `bun bench/run.ts --a <ref> --b <ref>` compares two versions with 5 interleaved rounds per side. The nightly workflow `.github/workflows/bench.yml` compares the baseline against `main`. CPU time and memory gate it; latency, throughput, wall-clock startup and image size are only reported, because hosted runners are too noisy for wall-clock numbers. `bun run bench:selftest` runs the harness self-tests (also in CI). It is not part of `bun test`. See [bench/README.md](../bench/README.md) for running it, changing a budget and reading a failure.

## Lint and format

Biome formats and lints (`bun run lint` to check, `bun run format` to fix). SonarJS runs through ESLint and limits cognitive complexity to 15 per function. The configuration comes from [pulse-config](https://github.com/lorenzh/pulse-config) (Biome, TypeScript, Lefthook and the ESLint setup) and brings TypeScript 6, while this repository uses TypeScript 7 (the `typescript7` dev dependency, run by `bun run typecheck`). `eslint.config.js` also ignores `.repos/` and `.bench/`. Never weaken the shared configuration to pass a check.

The Lefthook pre-commit hook (`lefthook.yml`) runs Biome and ESLint on staged files and rejects the commit on failure.

## CI

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and on tags `v*`. Its jobs:

- `check` uses the shared `check.yml` workflow of pulse-config (lint, typecheck, tests). `bun run lint` also runs `pulse-workflows` of pulse-config: every action is pinned to an approved SHA, every checkout sets `persist-credentials: false`, and the `pulse-config` refs equal the `package.json` pin.
- `bench-selftest` checks the performance bench scripts (`bun run bench:selftest`) and validates `bench/compose.bench.yaml`.
- `docker` runs twice, on `ubuntu-24.04` (amd64) and on `ubuntu-24.04-arm` (arm64), with the same steps on both legs. Each leg builds the image, runs `Image ignores dotenv files` (`bash scripts/image-dotenv.sh pulse-api:local`: the image's process and healthcheck ignore `.env`, `.env.production` and `.env.local` mounted into `/app`, and its `CMD` and healthcheck use `bun --no-env-file`), and checks that the image holds no test files.
- `release` runs only on a tag, after the gate jobs. It uses the shared `release.yml` workflow of pulse-config and publishes the image; see [Releasing](#releasing). On a pull request or a push to `main` it is skipped. A tag run is never cancelled by a newer run.

The Compose end-to-end test runs in [pulse-deploy](https://github.com/lorenzh/pulse-deploy) against released images and, daily, against `main` (its `dev` job).

## Releasing

A release is a git tag. The tag pushes a multi-arch image (linux/amd64 and linux/arm64) to `ghcr.io/lorenzh/pulse-api`. `package.json` `version` stays `0.0.0`; the version comes from the tag.

- The tag has the form `vX.Y.Z` or `vX.Y.Z-<pre-release>` (SemVer without build metadata, no leading zeros, for example `v0.1.0` or `v0.2.0-rc.1`). Any other tag fails the run before anything is built.
- A stable tag `vX.Y.Z` must point to a commit on `main`. A pre-release tag may point to any commit.
- A person pushes the tag. A tag pushed with a workflow's `GITHUB_TOKEN` starts no run.

```sh
git tag vX.Y.Z <sha on main> && git push origin vX.Y.Z
```

The tag run is gated: `release` starts only when `check`, both `docker` legs and `bench-selftest` pass. A failed, cancelled or skipped gate skips the release, and nothing is published. The release builds the image again from the same commit, so its digest can differ from the image that the `docker` job checked.

Image tags:

- `X.Y.Z` always.
- `X.Y` only when the release is the highest stable `vX.Y.*` tag, and `X` only when it is the highest stable `vX.*.*` tag. A late patch on an old minor does not move `X` back.
- A pre-release gets only its own tag, for example `0.2.0-rc.1`.
- There is no `latest` and no `edge` tag, and `main` publishes nothing.

Never move or re-push a release tag. The workflow refuses to publish a version that already exists in the registry, so the old image stays under that version. Make a new version instead.

Check the provenance of a release:

```sh
gh attestation verify oci://ghcr.io/lorenzh/pulse-api:<version> --owner lorenzh
```

In a setup, pin the exact version by digest (`ghcr.io/lorenzh/pulse-api:X.Y.Z@sha256:...`), because `X.Y` and `X` move.

## Documentation

These pages describe `main`. When behavior, a setting, an endpoint or a type changes, update the page in the same change. Every setting, key and route in the code must appear in the docs, and the docs must not name anything the code lacks. `README.md` keeps only the quick start and the links to these pages.
