# 6. Identity strings in public test fixtures

Date: 2026-08-04

## Status

Accepted.

## Context

`apps/vscode/src/repository-ready.test.ts` guards the Repository Ready card with a
`FORBIDDEN` list — strings that must never appear on a public-safe surface. The
intent is right and the guard is worth keeping.

Three of its entries were the maintainer's real surname, personal handle and
employer handle, hardcoded in a **public** repository. That publishes exactly the
values the guard exists to keep out, and it contradicts `docs/HANDOFF.md` §7:

> Public Yuhi artefacts — repo, npm, Marketplace, site, releases — must never
> contain the maintainer's real name, personal handle, or employer address.

An audit of the rest of the repository found no other occurrence: all 152 commits
are authored by `YUHI-AI-Labs`, there are no absolute `/Users/<name>` paths in
tracked files, no real email addresses (only `example.com` / `.invalid` fixtures and
npm metadata in `pnpm-lock.yaml`), and no tracked real data files.

## Decision

1. The three identity entries are replaced with synthetic canaries:
   `REAL_SURNAME_CANARY`, `PERSONAL_HANDLE_CANARY`, `EMPLOYER_CANARY`.

2. The output-scanning assertions are kept. They are cheap and they still catch a
   hardcoded leak.

3. Because those assertions can only catch a value that is already present, a
   **structural** assertion is added alongside them: every string on the public
   report must be one of the two closed enums (`safetyMode`, `status`). The report
   is otherwise numbers only, so there is nowhere for a path, filename or identity
   to live. Adding a free-form string field to the report now fails the test
   immediately, without waiting for a real value to leak to prove the point.

4. A maintainer who wants to scan for their own real values may do so locally with
   an untracked deny list. Those values must not be committed.

## Consequences

- **Current tree**: fixed. No tracked file contains the maintainer's real name,
  personal handle or employer.
- **Historical occurrence**: the values remain in git history from commit `24d6448`
  onward.
- **History rewrite**: **not performed.** Rewriting history changes every commit id
  after that point, which invalidates published tags (`v0.2.8` … `v0.4.2`), the
  GitHub Release assets pinned to them, the `yuhi.vsix` sha256 recorded in
  `docs/HANDOFF.md` §8, and any clone or fork. That is a repository-integrity
  decision with external blast radius, so it requires explicit maintainer approval
  and its own change — it is deliberately out of scope here.

If a rewrite is later approved, the smallest sufficient action is a targeted
`git filter-repo` over that one file's three lines, followed by re-tagging and
re-uploading the release assets, with the Marketplace listing republished from the
rebuilt VSIX.
