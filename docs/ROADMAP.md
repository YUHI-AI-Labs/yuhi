# Yuhi product roadmap after v0.3.6

This is the canonical product roadmap after Safe Patch Review. Feature-specific handoff
documents should link here instead of copying this plan.

## Product direction

Yuhi is an **agent-neutral repository preparation and evidence layer**.

```text
Prepare once.
Run with Claude Code or Codex.
Measure the difference.
Review before applying.
```

For the next six months, prioritize adoption and evidence over feature count:

- 50% product reliability, speed, and measurement
- 30% distribution, onboarding, and sharing
- 20% ecosystem, design partners, and external adoption

Default implementation allocation:

- 30% reliability and performance
- 25% benchmark and evidence
- 20% onboarding and distribution
- 15% SDK and ecosystem
- 10% security maintenance

## Phase 0 — v0.3.6 release stabilization

Complete clean packaging, isolated installation, real GUI and CLI E2E, upgrade checks,
README/Marketplace/npm consistency, Git tag, GitHub Release, Marketplace pre-release, and
npm release. Do not add features during this phase.

Release evidence must cover compression in the installed VSIX, Claude/Codex launch, patch
review, secret and source-conflict blocking, explicit Apply/Undo, and zero Source writes
without approval.

## Phase 1 — v0.3.7 Fast First Value

Goal: the first useful result in under 30 seconds.

- Measure activation, scan, deterministic preparation, Yuhi Mode readiness, and launch.
- Targets: small repository under 10 seconds, medium under 30, large under 60 where practical.
- Add local-only incremental preparation keyed by relative path, content/policy hashes,
  safety/compression settings, and processor version.
- Target no-change re-prepare under five seconds.
- Provide one official synthetic demo repository and a public-safe preparation summary.

Do not add agents, AST patching, automatic Git/PR actions, cloud dashboards, MCP, or new
language compressors in v0.3.7.

Gate: first-prepare completion above 60%, median prepare below 30 seconds, and at least 20
repeat users. If missed, improve speed/onboarding before starting v0.3.8.

## Phase 2 — v0.3.8 Yuhi Bench

Build reproducible comparisons of full, prepared, and compressed representations using a
stable task schema and allowlisted validation commands. Measure task success, patch
correctness, tokens when provider-reported, runtime, tool calls, files opened/modified,
context reduction, safety events, and estimated cost. Never generalize one run, hide
failures, expose private prompts/source/environment, or use private APIs.

Success target: 100 public reports, 20 external bench users, and at least 90% reproducible
results. Gate progression on 20 external runs and at least one measured benefit without
reducing task success.

## Phase 3 — v0.3.9 Evidence Distribution

- Report-only GitHub Action comments; never Apply from CI.
- Repository badges only for measured results, including honest zero-reduction results.
- Static public benchmark gallery.
- Synthetic fixture and instructions for a 60-second Prepare → agent switch → Review →
  Apply → Undo demo.

Gate: 100 shared reports, measurable GitHub-star conversion, and 50 monthly active users.

## Phase 4 — v0.4.0 Adapter and Conformance SDK

Stabilize adapter/context/conformance packages only after external demand. Conformance must
check structured argv, Prepared-root launch, Context ID preservation, cancellation,
timeouts, safe public output, session provenance, and no automatic Source Apply. Explicitly
installed representation plugins require declared capabilities, an allowlisted ID, timeout,
and fail-safe FULL fallback.

Gate: two external integrations, three external contributors, and one repeating design
partner. Weaken platform/standard claims if this is not achieved.

## Design Partner track

Recruit three organizations that need repository preparation before permitting Claude Code
or Codex. Measure preparation, repeat usage, agents, policy events, patch reviews, prevented
conflicts, approval status, and satisfaction. Do not collect source, raw prompts, secrets,
usernames, or machine paths.

Six-month minimum targets: 300 GitHub stars, 500 VS Code installs, 100 monthly active users,
20 four-week retained users, three external contributors, 100 benchmark reports, three
design partners, and one written enterprise proof of value.

## Deferred unless user evidence changes priority

- AST-aware patches for compressed files
- automatic three-way merge, Git commit, or pull request
- cloud dashboard, SSO/RBAC, or SOC 2 work
- more than two additional agents
- new programming languages or MCP server

## Decision principle

Prioritize measured evidence, repeat usage, external dependency, community contribution,
enterprise proof, and reproducible benchmark data. Before building a feature, ask whether
users would still need Yuhi if an agent vendor implemented the same feature.
