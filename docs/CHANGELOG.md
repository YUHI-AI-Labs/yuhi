# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While Yuhi is in `0.x`, minor releases may include breaking changes; these will
be called out explicitly.

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
