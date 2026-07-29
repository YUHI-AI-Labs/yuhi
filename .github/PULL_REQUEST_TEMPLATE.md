<!--
Thanks for contributing to Yuhi! Please fill out this template so reviewers have
the context they need. Keep PRs focused and reasonably small where possible.
-->

## Summary

<!-- What does this PR do, and why? Link any related issue. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation only
- [ ] Chore / refactor / tooling
- [ ] New agent adapter
- [ ] New secret detector

## What changed

<!-- Bullet the key changes. Mention affected packages/apps, e.g. @yuhi/policy. -->

-

## How was this tested?

<!-- Commands you ran, new tests you added, manual verification steps. -->

- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`

## Security checklist

Yuhi is a security tool, so please confirm the following where relevant:

- [ ] This change does not weaken default blocking/redaction behavior.
- [ ] If it touches the scanner/policy/workspace, I added or updated **security
      regression tests** (true positives *and* true negatives).
- [ ] No real secrets, tokens, or credentials are included anywhere (fixtures
      use obviously fake values).
- [ ] I did **not** introduce any "completely safe / 100% secure / guaranteed no
      leaks" style overclaiming in code, docs, or UI copy.
- [ ] Feature status is labeled honestly (Stable / Experimental / Planned / Not
      implemented) where user-facing.

## Documentation & changelog

- [ ] Updated relevant docs (if behavior or usage changed).
- [ ] Updated `CHANGELOG.md` under `## [Unreleased]` (if behavior changed).

## Notes for reviewers

<!-- Anything reviewers should pay special attention to, trade-offs, follow-ups. -->
