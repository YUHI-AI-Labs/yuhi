# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While Yuhi is in `0.x`, minor releases may include breaking changes; these will
be called out explicitly.

## [0.3.5]

Progressive Context — *Start fast. Context gets better in the background.*

- **Background preparation queue** — heavy steps (PDF/DOCX extraction, OCR, local
  summarization) are deferred to a **persistent background queue** that runs *after* Yuhi Mode
  is ready, so launch is never blocked and foreground wall-time does not grow with the number
  of pending items. The queue survives restart, recovers stale in-flight items, dedupes by
  idempotency key, never re-runs completed items, isolates a single failure, bounds
  concurrency (local model = 1), opens a circuit breaker to zero further calls after repeated
  provider failures, and terminates a hanging provider.
- **Safety-gated atomic publish** — each background result is normalized → pseudonymized →
  safety-inspected *before* anything is written; only a verified, sanitized companion is
  published atomically into the agent-visible workspace. A secret- or PII-bearing result is
  **kept local**; failures leave no partial artifact; the original source and raw document are
  never delivered.
- **Immutable Context ID + incrementing Context Revision** — the base Context ID stays
  byte-identical as background work completes; each safely-published artifact bumps a
  deterministic `revisionId` that folds in the immutable Context ID plus the published set. It
  is time-, path-, machine-, user-, and **agent-independent** — Claude and Codex reuse the
  *same* prepared run and compute the *same* revision, with no re-scan or re-preparation. Each
  Agent Session Manifest records the revision it used.
- **VS Code**: panel status (per-kind progress, safe artifacts added, kept-local, current
  revision), **Cancel background processing**, and **Refresh Context** (re-read + recompute,
  never a re-prepare) — all sourced from a single path-safe public status file.
- **CLI**: `yuhi background` reports status (`--json` for machine-readable) and can start,
  cancel (whole-run or `--item`), and retry (`--failed-only`); public output never prints an
  absolute path or raw error.
- **Private-state boundary** — the queue's private records, pre-inspection staging, and cancel
  flags live under the managed base (`.internal/background/<runId>`), *outside* every
  agent-visible prepared root; the agent reads only the public status file.

## [0.3.4]

One prepared repository, multiple agents — *Prepare once. Run with Claude or Codex.*

- **Agent adapters (Claude Code + Codex)** — Yuhi's core stays agent-agnostic; each agent is
  a small adapter that detects the CLI (short timeout, no auto-install), generates its
  instruction file (`CLAUDE.md` / `AGENTS.md`) additively, and launches it in the prepared
  repository with a safe argv-array spawn. Unknown agent ids are rejected.
- **Deterministic Context ID** (`sha256:…`) over source hashes + Safety Mode + compression
  settings — identical for the same repository state, invariant across agent and time. The
  Context Manifest is deterministic; the per-run Agent Session Manifest is separate and its
  public export omits absolute paths and environment.
- **CLI**: `yuhi launch claude` / `yuhi launch codex` (`--run <id>` to select a prepared
  run) print a short Ready summary and launch in the prepared repository.
- **VS Code**: a **Launch with Claude Code / Codex** picker on the review surface — same
  prepared run reused by either agent, per-agent availability, last-used remembered, and a
  changed Safety Mode still gates launch.

## [0.3.3]

Safe, lightweight, explainable context preparation.

- **Context Compression (opt-in)** for TS/JS: keep imports/exports/signatures/decorators/
  doc-comments, drop implementation bodies — including **arrow-function block bodies**
  (`const fn = () => { … }`), while keeping expression-body arrows that return objects/JSX.
  Unsupported languages and any parse failure fall back to the full file; the original
  source is never modified. Every file's outcome carries a stable, machine-readable reason.
- **Faster, never-stuck preparation**: the local summarization model is off the launch
  path, so Yuhi Mode opens quickly even on large repos or with a slow/absent local model.
  Files needing local summarization to be de-identified are kept local (not shared).
  Per-file timeout, cancellation, and a circuit breaker prevent one slow file from
  stalling the run.
- **VS Code**: choose Safety Mode / Context Compression / Token Budget before the first
  prepare; a version badge shows the installed build. Kept-local document placeholders
  report an accurate size and a specific reason.

## [0.3.0] — released

Repository Ready: a shareable, **public-safe** Repository Report (terminal / Markdown / JSON /
SVG), a read-only **What the AI Can See** review in VS Code, per-format document inspection that
delivers sanitized companions or safe placeholders (originals of PDF/DOCX/PPTX are never shared),
and the report-only Yuhi GitHub Action. The VS Code extension is published on the Marketplace
(0.3.0); the npm package `@yuhi-ai-labs/yuhi` is published on the `beta` dist-tag.
**CLI agent launch (`yuhi run` / `yuhi open`) is temporarily disabled** — prepare and report on
the CLI; launch Claude Code from the VS Code extension.

## [Unreleased]

The items below describe the initial end-to-end flow. Some early command surface (notably
`yuhi run <agent>` CLI agent launch) is **superseded / temporarily disabled** in 0.3.0; launch is
now driven by the VS Code extension.

### Added

- **CLI (`yuhi`)** with the core commands:
  - `yuhi init` — scaffold a `yuhi.yaml` policy in the current repository.
  - `yuhi scan` — scan the repository and report what would be blocked or
    redacted, without materializing a workspace.
  - `yuhi preview` — show the resolved policy decisions (allow / deny / redact)
    for the repository so you can see exactly what an agent would receive.
  - `yuhi workspace` — materialize a filtered copy of the allowed files into
    `~/.yuhi/workspaces/<id>` without modifying the original repository.
  - `yuhi run <agent>` — launch an agent inside the generated workspace.
- **Policy engine** (`@yuhi/policy`) — evaluates allow/deny/redact rules from
  `yuhi.yaml`, including glob-based path rules and precedence handling.
- **Scanner** (`@yuhi/scanner`) — repository walker with a set of built-in
  secret detectors, producing findings that feed the policy engine.
- **Workspace materialization** (`@yuhi/workspace`) — copies allowed files into
  the generated workspace, applies redaction, and leaves the source repository
  untouched.
- **Agent adapters** (`@yuhi/agents`):
  - **dummy** adapter (Stable) — echoes the command it *would* run; used for
    tests and CI so no real agent is invoked automatically.
  - **Claude Code** adapter (Experimental) — launches Claude Code in the
    generated workspace.
- **Audit log** (`@yuhi/audit`) — records what was scanned, which decisions were
  made, and what an agent was given, for after-the-fact review.
- **Config loading & validation** (`@yuhi/config`) — loads and validates
  `yuhi.yaml` with sensible defaults.
- **VS Code extension** (Experimental) — early integration surfacing scan and
  preview results in the editor.
- Project documentation, contribution guidelines, security policy, governance,
  and CI/release scaffolding.

### Security

- Yuhi is **defense-in-depth, not a sandbox**. The launched agent still has
  network access and can attempt to read files outside the generated workspace.
  See [SECURITY.md](../.github/SECURITY.md) for scope and limitations.

### Notes

- Codex CLI and Gemini CLI adapters are **Planned / Not implemented** in this
  MVP.
- OS-level sandboxing is **Not implemented** and out of scope for the MVP.

<!--
When the first release is cut, move the relevant items above into a dated
section like the example below and reset [Unreleased] to empty.

## [0.1.0] - 2026-07-24  (NOT YET RELEASED — placeholder)
-->

[Unreleased]: https://github.com/YUHI-AI-Labs/yuhi/commits/main
