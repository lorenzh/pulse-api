# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run check    # lint, then typecheck, then tests
npm run lint     # Biome check, no changes
npm run format   # Biome check with fixes applied
```

A Lefthook pre-commit hook (installed by `npm ci` via `prepare`) runs Biome on staged files and blocks badly formatted or linted commits.

## Conventions

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
