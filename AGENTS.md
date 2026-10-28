# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run check    # lint, then typecheck, then tests
npm run lint     # Biome check, then SonarJS via ESLint (cognitive complexity <= 15), no changes
npm run format   # Biome check with fixes applied
npm test         # node:test with a line coverage gate of 80 %
```

A Lefthook pre-commit hook (installed by `npm ci` via `prepare`) runs Biome and ESLint (SonarJS) on staged files and blocks badly formatted or linted commits. The ESLint config and its TypeScript 6 dependencies live in the `tools/sonarjs` workspace; the root keeps TypeScript 7.

## Conventions

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
