# Governance

This document describes how the **Yuhi** project is governed. Yuhi is an early,
solo-maintained open-source project, so this governance is intentionally
lightweight. It exists to make decision-making transparent and to describe how
the model will evolve as the community grows.

## Model: BDFL-lite

Yuhi currently follows a **BDFL-lite** ("Benevolent Dictator For Life", scaled
down for an early project) model:

- A single **lead maintainer** holds final decision authority and release
  authority.
- Decisions are made **in the open** (issues, pull requests, and Discussions)
  and favor community input, but the lead maintainer breaks ties and sets
  direction.
- This is a starting point, not a permanent structure. As trusted contributors
  emerge, authority will be shared (see *How Roles Evolve*).

## Values

All decisions are weighed against Yuhi's core values. When values appear to
conflict, they are considered roughly in this order:

1. **Honesty over hype.** No overclaiming. Yuhi is defense-in-depth, not a
   sandbox or a security guarantee. Feature status is labeled truthfully
   (Stable / Experimental / Planned / Not implemented).
2. **Local-first.** Yuhi runs on the user's machine and operates on local
   files. Cloud dependencies are avoided.
3. **Privacy-first, no telemetry by default.** Yuhi does not phone home. Any
   future optional telemetry would be strictly opt-in, documented, and off by
   default.
4. **Vendor-neutral.** Yuhi supports multiple AI agents and does not privilege
   one vendor. Adapters are pluggable.
5. **Cross-platform.** macOS, Linux, and Windows are all first-class.
6. **Apache-2.0-licensed and open.** The project stays permissively licensed and
   community-friendly.

A change that violates a core value should be rejected regardless of its other
merits.

## Roles

### Users

Anyone who uses Yuhi. Users contribute enormous value through bug reports,
feature requests, and feedback.

### Contributors

Anyone who submits a pull request, files a well-scoped issue, improves docs, or
helps others in Discussions. No formal status is required to contribute — see
[CONTRIBUTING.md](CONTRIBUTING.md).

### Maintainers

Contributors who have earned commit/triage rights. Maintainers review and merge
pull requests, triage issues, shepherd releases, and uphold the values above.
Early on there is a single maintainer (the lead).

### Lead Maintainer

Holds final decision and release authority. Responsible for the project's
overall direction, security response, and for growing the maintainer team.

## Decision Process

- **Everyday changes** (bug fixes, docs, tests, small features): handled through
  normal pull-request review. Lazy consensus applies — if there are no
  outstanding objections after review, it can be merged.
- **Significant changes** (new subsystems, public CLI/API changes, changes to
  defaults or security posture): should start as an issue or Discussion
  describing motivation and trade-offs, so the community can weigh in before
  code is written.
- **Disagreements**: resolved by seeking consensus first. If consensus can't be
  reached, the lead maintainer decides and documents the rationale.
- **Security decisions**: follow [SECURITY.md](SECURITY.md) and may be handled
  privately until a fix ships.

## Code Review

- All non-trivial changes go through pull request review before merging.
- At least one maintainer approval is required to merge. The lead maintainer's
  own changes should still be opened as PRs where practical, for visibility and
  CI, even if self-merged early in the project.
- CI (build, typecheck, lint, tests on Linux/macOS/Windows) must pass before
  merge.
- Reviewers check for: correctness, tests (including security regression tests
  where relevant), honest status labeling, and adherence to project values.

## Release Authority

- The lead maintainer authorizes releases and version bumps.
- Releases follow the [PUBLISH_CHECKLIST](docs/PUBLISH_CHECKLIST.md).
- Publishing to npm, the VS Code Marketplace, and Open VSX is **gated and
  manual** — it requires maintainer-held secrets and explicit approval, and is
  never triggered automatically by CI on ordinary commits.
- Versioning follows [Semantic Versioning](https://semver.org/). While Yuhi is
  `0.x`, minor versions may include breaking changes, which will be noted in the
  [CHANGELOG](CHANGELOG.md).

## How Roles Evolve

The BDFL-lite model is deliberately temporary. As the project matures:

1. **Adding maintainers.** Contributors who show sustained, high-quality
   involvement and good judgment may be invited to become maintainers by the
   lead maintainer, ideally with input from existing maintainers.
2. **Shared authority.** As the maintainer team grows, decision-making shifts
   from a single person toward maintainer consensus, with the lead retaining a
   tie-breaking role.
3. **Formalization.** If and when the community is large enough, this document
   will be revised toward a more formal model (e.g. a steering committee or a
   maintainer council with a documented voting process).

Changes to this governance document are themselves decisions made through the
process above and are recorded in version control.

## Amendments

This document can be amended via pull request. Substantive governance changes
should be announced in Discussions to give the community a chance to comment
before they are adopted.
