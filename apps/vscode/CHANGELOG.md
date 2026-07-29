# Changelog

All notable changes to the Yuhi VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`, minor
releases may include breaking changes.

## [0.2.2]

> Early preview. Not yet recommended for production, regulated data, or highly
> sensitive workflows.

### Added

- Yuhi-first Prepared Workspace launch commands for a new VS Code window and for
  the official Claude Code extension or CLI.
- Explicit pre-launch review, high-risk override confirmation, metadata-only
  session/audit records, and a persistent **Prepared by Yuhi** indicator.
- Detailed context-reduction, sensitive-data, per-file policy, and exact prepared-tree
  review.
- Schema v2 Prepared Workspace metadata with backward-compatible schema v1 reading,
  shared runtime-boundary state, metadata-safe provenance, and filterable file decisions.

### Security

- Prepared launch paths are containment-checked and symlinked run directories are
  rejected.
- Generated Yuhi state and local `yuhi.yaml` files are excluded from the VSIX.
- The UI explicitly states that Yuhi prepares initial context but does not provide an
  OS-level sandbox.
- Unsupported PDF files are kept local when verified inspection is unavailable.
- Unsupported high-risk XLSX files remain local, produce a Partial result, and block
  Claude Code launch. Raw source files are never used as fallback.

### Known limitations

- PDF and XLSX parsing/transformation are not supported in this release.
- Large workspaces may take longer to prepare.
- Yuhi does not provide OS-level filesystem confinement.
- CLI agent launch is temporarily disabled until full parity is complete.

## [0.1.0] — Beta

First public beta. A focused, local-first preparation + review workflow.

### Added

- **Yuhi: Doctor** — diagnoses the local setup: Ollama binary on PATH, runtime
  reachability, whether the configured model is installed, `.yuhi` writability, and
  whether the project is initialized, with actionable next steps.
- **Yuhi: Setup Local AI** — guides local-model setup. If Ollama is missing it links to
  the official download (never auto-installs). Otherwise it offers the recommended model
  tiers (`qwen3:1.7b` preselected), requires an explicit modal confirmation before any
  download, runs `ollama pull` with a cancellable progress bar, smoke-tests the model, and
  saves the choice to `yuhi.yaml`.
- **Yuhi: Prepare Workspace** and the **Prepare with Yuhi** Explorer context action —
  prepare the workspace locally with progress and cancellation; output is written under
  `.yuhi/prepared/<runId>/`. Source files are never modified.
- **Yuhi: Review Prepared Context** — a "Context Savings" webview with Original vs Prepared
  estimated tokens, reduction, counts of files summarized / excluded / masked,
  "Source files modified: 0", and per-file Original ↔ Prepared diffs.
- Status bar reflecting the live state (ready / Ollama missing / Ollama stopped / model
  missing / preparing / ready for review / failed) and first-run onboarding.

### Notes

- No content is forwarded to Claude in this beta — the review step is the intended stop.
- No telemetry; no external network calls during preparation or review.
