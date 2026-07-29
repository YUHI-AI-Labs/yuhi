# ADR-0002: Monorepo tooling (pnpm + tsx + vitest + tsup)

Date: 2026-07-24 · Status: Accepted

## Context
We need a TypeScript pnpm monorepo with multiple internal packages that import each
other, that runs today (dev + tests) without a fragile build-ordering step, yet still
produces publishable `dist/` artifacts.

## Decision
- **pnpm workspaces** for package linking (`workspace:*`).
- Packages expose `src/index.ts` as their dev entry; **`tsx`** runs TS directly, and
  **`vitest`** (esbuild-based) runs tests without pre-building.
- **`tsup`** builds each package to `dist/` (ESM + `.d.ts`) for publishing; the
  published `exports` map points at `dist/`.
- Avoid TypeScript project references / composite builds for MVP: they add build
  ordering complexity and frequent breakage for little MVP benefit.

## Consequences
- Fast inner loop; no cross-package build needed to run `yuhi` in dev via tsx.
- `pnpm -r build` produces artifacts before publish. CI runs typecheck + test + build.
- Slight duplication: dev resolves `src`, prod resolves `dist`. Handled via package
  `exports` conditions and a dev bin that uses tsx.
