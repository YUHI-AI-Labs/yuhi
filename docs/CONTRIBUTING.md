# Contributing to Yuhi

Thanks for your interest in contributing to **Yuhi** — a local-first,
Apache-2.0-licensed workspace that gives you control over what an AI coding agent is
allowed to see. Contributions of all kinds are welcome: bug reports, docs,
tests, secret detectors, agent adapters, and core features.

This document explains how to set up your environment, how the codebase is
organized, and the conventions we follow.

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

## Ground Rules

Yuhi is a security tool, and we hold ourselves to an honesty standard:

- **No overclaiming.** Yuhi is *defense-in-depth*, not a sandbox or a security
  guarantee. Never describe a feature as "completely safe", "100% secure", or
  "guaranteed no leaks" in code, docs, or UI copy.
- **Be explicit about status.** New features should be labeled honestly as
  *Stable*, *Experimental*, *Planned*, or *Not implemented*.
- **Local-first and vendor-neutral.** No telemetry by default. No hard
  dependency on a single agent vendor.

## Prerequisites

- **Node.js 20+** (Node 20 and 22 are tested in CI)
- **pnpm 10+** (this is a pnpm monorepo)

Enable pnpm via Corepack if you don't have it:

```bash
corepack enable
corepack prepare pnpm@10 --activate
```

## Getting Started

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/yuhi.git
cd yuhi

# 2. Install dependencies (uses the committed lockfile)
pnpm install

# 3. Build all packages
pnpm build

# 4. Run the test suite
pnpm test

# 5. Type-check and lint
pnpm typecheck
pnpm lint
```

Run these four commands — `build`, `test`, `typecheck`, `lint` — before opening
a pull request. CI runs the same checks on Linux, macOS, and Windows.

To run the CLI from source during development:

```bash
pnpm --filter @yuhi-ai-labs/yuhi build
node apps/cli/dist/index.js --help
```

## Monorepo Layout

```
yuhi/
├── apps/
│   ├── cli/            # yuhi — the `yuhi` binary (init, scan, preview, run)
│   └── vscode/         # VS Code extension
├── packages/
│   ├── shared/         # shared types, utilities, logging
│   ├── config/         # yuhi.yaml loading, validation, defaults
│   ├── policy/         # policy engine (allow/deny/redact decisions)
│   ├── scanner/        # repo scanning + secret detection
│   ├── workspace/      # filtered workspace materialization under ~/.yuhi
│   ├── agents/         # agent adapters (dummy, Claude Code, Codex, Gemini)
│   ├── audit/          # audit log writer/reader
│   └── core/           # orchestration tying the above together
```

Package scope is `@yuhi/*`. Cross-package imports go through published package
entry points, not deep relative paths.

## Development Conventions

### Commit messages: Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/). Examples:

```
feat(scanner): add detector for GitHub fine-grained PATs
fix(policy): treat glob negations as higher precedence
docs(getting-started): clarify preview output
test(workspace): add regression for symlink escape
chore(deps): bump zod to 3.x
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`ci`, `chore`. Use a scope matching the package or app you touched.

### Sign-off (DCO) — optional

Sign-off is appreciated but not required. If you'd like to certify your
contribution under the [Developer Certificate of Origin](https://developercertificate.org/),
add a `Signed-off-by` trailer:

```bash
git commit -s -m "fix(policy): ..."
```

## How to Add an Agent Adapter

Agent adapters live in `packages/agents`. An adapter's job is to launch a
supported AI coding agent *inside the generated workspace directory*, not the
original repo.

1. Create a new module under `packages/agents/src/adapters/<name>.ts`.
2. Implement the shared adapter interface (see `packages/agents/src/types.ts`):
   - a stable `id` (e.g. `"claude"`, `"codex"`, `"gemini"`),
   - a `detect()` that reports whether the agent's CLI is installed,
   - a `buildCommand(ctx)` returning the executable + args + cwd (the workspace
     path) + environment.
3. Never hardcode secrets. Read credentials from the user's existing environment;
   do not copy them into the workspace unless policy explicitly allows it.
4. Register the adapter in the adapter registry.
5. Add unit tests that assert the command is built with the workspace as `cwd`
   and that no disallowed environment is injected.

Use the existing **dummy** adapter as a reference — it echoes what it would run
and is used in tests and CI so we never invoke a real agent automatically.

## How to Add a Secret Detector

Detectors live in `packages/scanner`. A detector flags content that should be
blocked or redacted before it reaches the workspace.

1. Add a detector under `packages/scanner/src/detectors/`.
2. Provide:
   - a unique `id` and human-readable `name`,
   - a matcher (regex and/or entropy heuristic),
   - a `severity` and a default action (`block` or `redact`),
   - an example of what it catches and what it should *not* catch.
3. Add tests with both **true positives** and **true negatives**. False
   positives are a real cost for users, so include realistic non-secret samples.
4. Add at least one entry to the **security regression** fixtures so we never
   silently regress detection.

## Testing Expectations

Three layers of tests are expected, depending on what you touch:

- **Unit tests** — pure logic (policy decisions, detector matching, config
  parsing). Fast and deterministic.
- **Integration tests** — end-to-end flows using the **dummy** adapter and
  temporary directories (init → scan → preview → workspace → run). These must
  never contact the network or launch a real agent.
- **Security regression tests** — fixtures of known-sensitive content (fake
  secrets, sensitive paths, symlink-escape attempts) asserting they are blocked
  or redacted. When you fix a security bug, add a regression test for it.

Please do not add tests that require real agent credentials or network access to
pass; CI cannot and should not run those.

## Pull Requests

1. Branch from `main`.
2. Keep PRs focused and reasonably small.
3. Ensure `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all pass.
4. Update `CHANGELOG.md` under `## [Unreleased]` when behavior changes.
5. Fill out the pull request template, including the security checklist.

## Good First Issues

New here? Look for issues labeled
[`good first issue`](https://github.com/YUHI-AI-Labs/yuhi/labels/good%20first%20issue) — they're scoped to be approachable
without deep knowledge of the whole codebase. Good starting points typically
include:

- Adding a new secret detector with tests.
- Improving error messages and CLI output.
- Expanding documentation and examples.
- Adding test fixtures for edge cases.

If an issue is unclear, ask in the issue thread or in
[Discussions](../.github/DISCUSSIONS.md) before writing code — we're happy to help
you scope it.

## Questions

Open a thread in **GitHub Discussions** (Q&A) or comment on a relevant issue.
For anything security-sensitive, follow [SECURITY.md](SECURITY.md) instead of
filing a public issue.
