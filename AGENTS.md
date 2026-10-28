# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run check    # typecheck, then tests
```

## Conventions

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
