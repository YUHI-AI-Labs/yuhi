# Changelog

All notable changes to the Yuhi VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`, minor
releases may include breaking changes.

## [0.3.3]

Theme: **safe, lightweight, and explainable context preparation** — get into Yuhi Mode
fast, keep the prepared context small, and always be able to explain why.

### Context Compression (opt-in)

- **Structure compression** for TypeScript/JavaScript: keeps imports, exports, class /
  interface / type / enum declarations, function and method **signatures**, decorators,
  and doc-comments, and drops implementation bodies (replaced with `{ /* ... */ }`) to
  shrink the context sent to the agent. Enable with the **Context Compression** toggle
  or `yuhi.compress`; set an optional **Token Budget** (`yuhi.tokenBudget`).
- **Arrow-function bodies** are now compressed too: `const fn = () => { … }` collapses to
  its signature, which markedly improves reduction on function- and test-heavy files.
  Expression-body arrows are kept in full on purpose — `() => ({ … })` (config objects)
  and `() => <div/>` (JSX) preserve structure a coding agent needs.
- Every file's outcome is explainable: kept full, structurally compressed, or excluded —
  each with a stable reason (e.g. `structural-compression`, `parse-failed`,
  `compression-not-smaller`). Unsupported languages and any parser/parse failure fall
  back to the full file — never a partial or silently dropped one. The original source is
  never modified.
- Declaration (`.d.ts`) files and files below the size threshold are kept full. Context
  Compression is **OFF by default** — opt in per run. Reduction is content-dependent and
  honest: method- and arrow-heavy files compress a lot (a ~190k-token repo → ~41%, with
  body-heavy test files ~85%), while small or declaration-only repositories stay near 0%.

### Faster, never-stuck preparation

- Preparation no longer waits on the local summarization model on the launch path, so
  **Yuhi Mode opens quickly** even on large repositories and even when a local model is
  slow or unavailable. Files that would need local summarization to be de-identified are
  kept **local** and clearly reported (they are not shared with the agent). Reliability
  guards — per-file timeout, cancellation, and a circuit breaker — keep a single slow file
  from stalling the whole run.

### Choose settings before the first prepare

- The Yuhi panel now offers **Safety Mode**, **Context Compression**, and **Token Budget**
  before the first prepare — no need to prepare once to reach the selector. Choices are the
  same `yuhi.*` workspace settings used everywhere, and stay in sync with VS Code Settings.
- A small **`Yuhi v…`** badge in the panel shows the installed extension version.

### Clearer kept-local documents

- When a PDF/DOCX/PPTX can't be inspected, the local placeholder now reports an accurate
  original size (bytes/KB, not a misleading `0.0 MB`) and a specific reason.

## [0.3.3]

### Context Compression (opt-in)

- **Structure compression** of the delivered context — the **Context Compression** toggle
  in VS Code, or `yuhi prepare --compress`. Produces a deterministic, body-omitted,
  syntactically valid view: imports, exports, declarations, class/interface/type and
  function/method signatures (with their doc comments) are preserved; implementation
  bodies — including **block-body arrow functions** — are replaced by `{ /* ... */ }`.
- Kept **full** by design: expression-body arrows (`x => x * 2`, `() => ({ ... })`,
  `() => <div/>`), declaration (`.d.ts`) files, and files below the size threshold.
- Reduction is content-dependent and honest: method- and arrow-heavy files compress a
  lot (a ~190k-token repo → ~41%, with body-heavy test files ~85%), while small or
  declaration-only repositories stay near 0%. The original source is never modified, and
  an unparsable file safely falls back to its full form.
- Default **OFF**; opt in per run.

## [0.3.2]

### Safety Mode

- A **Safety Mode** preset — **Balanced** (default), **Strict**, **Maximum Privacy** —
  chosen from a selector in the review, or `yuhi prepare --safety-mode <mode>`, or the
  `yuhi.safetyMode` workspace setting / `yuhi.yaml`. Higher modes keep more content
  local; each withholds a strict superset of the mode below it, and no mode ever
  weakens a hard block. Credentials and PII are never delivered raw in any mode.
- The selected mode shapes the effective preparation policy in the core, so the CLI,
  VS Code, and reports all behave identically. The resolved mode is saved in the
  manifest and shown in the Repository Report.
- Changing the mode marks the prepared workspace **out of date** — a *Re-prepare
  required* banner appears and launching Claude Code is blocked until you re-prepare
  with the selected mode.
- Report wording clarified: *Secrets blocked* counts credential files kept fully
  local; *Identifiers transformed* counts all redacted/pseudonymized sensitive values
  (PII and secret redactions).

## [0.3.1]

First published 0.3.x release. Folds in the 0.3.0 work below plus a concise, softened
Marketplace overview and the 0.2.6 / 0.2.8 reliability and privacy hotfixes. Safety Mode
and per-file overrides are in progress for a following release.

### Repository Ready — the shareable preparation report

- After a successful prepare, the review panel shows a **Repository Ready** card with
  concrete, measurable outcomes: source files, prepared artifacts, documents prepared,
  secrets blocked, identifiers transformed, and the estimated accessible-content
  reduction. Wording is honest: *estimated accessible content, not model token savings*.
- **Copy public report** copies the Markdown report to the clipboard; **Export…** saves
  it as Markdown, JSON, or an SVG badge. Every format is **public-safe** — aggregate
  numbers only, never a filename, path, secret type, or identity — so it is safe to paste
  into a README, a PR, or a post.
- Positioning refresh: "Turn any repository into an AI-ready repository." The listing and
  README now lead with preparation outcomes and correct the document capabilities
  (PDF/DOCX/PPTX are converted to sanitized companions; they are no longer "unsupported").

### What the AI Can See (read-only review)

- A collapsed-by-default review below the Repository Ready card that makes "what the AI can
  see, and what stays on your machine" obvious at a glance: **Available to the AI** vs
  **Unavailable to the AI**, split into prepared/transformed, included unchanged, excluded
  by user, excluded by policy, and kept local because verification failed.
- Each file shows what Claude receives (nothing / unchanged / transformed), the reason, and
  an Original ↔ Prepared diff where available; a filter narrows the list. The applied Safety
  Mode and Context Detail are shown as labels. Warnings (delivered with a caveat) are visually
  distinct from withheld files, and leak-free launchable runs stay calm.
- This is review-only; changing decisions and modes arrives in a later update. The public
  report stays public-safe — file paths shown here never enter the copied/exported report.

## [0.2.9]

### Document protection (PDF / DOCX / DOCM / PPTX / PPTM)

- Original office/PDF documents are **no longer shared with the agent**. Yuhi extracts
  the text locally, scans and redacts structured identifiers/secrets, and delivers a
  **sanitized Markdown companion** — the original binary is never placed in the
  Prepared Workspace and the source file is never modified.
- A document that cannot be inspected — over the size limit (PDF > 64 MB, Office >
  128 MB), encrypted, broken, or macro-only — is delivered as a **safe placeholder**
  that states the original was kept local, never a raw passthrough.
- Companions disclose source type, page/slide counts, extraction method, redaction
  count, uninspected images/embedded objects, macros, and an explicit **residual
  free-text-name risk** — no claim of full anonymization; no source path or filename.
- The final-artifact gate now also rescans generated companions; a surviving
  credential causes the companion to be withheld and recorded honestly.
- Office extraction uses a ZIP-bomb-safe reader (entry/size/ratio caps, path-traversal
  and symlink rejection); macros are never executed and VBA projects never shared.

### Per-format inspection & reliability

- The single 2 MB inspection gate is removed for text/CSV/TSV: large files are
  de-identified (prepare-locally + final-gate re-scan), never raw-allowed or merely
  kept local. Isolated per-format limits (PDF 64 MB; in-memory transform ceiling).
- Managed workspace cleanup (keep newest 3, > 7 days pruned) with **marker-based
  safety** — a directory is deleted only when a valid `.yuhi-managed.json` marker
  confirms Yuhi created it (never by name, never a symlink, never unverifiable).

### Not in this release (tracked for a follow-up)

- XLSX streaming for very large workbooks and the `yuhi clean` CLI are not yet
  included; large XLSX continue to use the existing bounded handling.

## [0.2.8]

### Critical fix

- Fixed the root cause of "Yuhi could not complete workspace preparation" on real
  workspaces. Yuhi generates an `AGENT_HANDOFF.md` that lists filenames, re-scans it,
  and previously **threw** on any finding — so a workspace containing a file with a
  long high-entropy name (or other detector-tripping filename) made Yuhi's *own*
  generated file fail its rescan and abort the entire, already-completed preparation.
  Yuhi now sanitizes the generated handoff (redacting flagged spans, and — as a
  guaranteed-clean fallback — omitting the per-file listings) and always writes it.
  A generated file can never again fail the whole run.

## [0.2.7]

### Diagnostics & recovery

- A preparation failure now writes the actual error (its type/code — e.g. ENOENT,
  EACCES, ENOSPC — with all source paths redacted) to Yuhi Output, instead of only
  an opaque category. This makes a stubborn failure diagnosable.
- The failure dialog is now modal with Retry / Switch Workspace / View Yuhi Output
  (and the built-in Cancel), so the recovery choices can never be missed or
  auto-dismissed. Details of the failure are shown inline.

## [0.2.6]

### Reliability

- **A single problematic file never fails the whole preparation.** In a large, active
  workspace a file can be removed, moved, locked, or changed while Yuhi is preparing.
  Each file is now processed in isolation: if one cannot be read or processed, it is
  skipped with a note and preparation continues, instead of aborting the entire run
  with "preparation-failure". The same isolation applies to the final privacy rescan.

## [0.2.5]

### Privacy & correctness

- Adds a mandatory final-artifact security gate: after every write, rename, and
  fallback, Yuhi reopens each delivered CSV/TXT/XLSX from disk and scans the actual
  bytes. A file is reported de-identified only when its final on-disk bytes are clean.
  A surviving credential is kept local; a surviving personal identifier is delivered
  with a warning and never labelled "verified".
- Never claims "Sensitive values handled" / "Transformed copies verified" when a
  delivered file still contains identifiers — shows an explicit "could not be fully
  de-identified — review before sharing" instead.
- XLSX: a parseable workbook is delivered with identifier columns pseudonymized rather
  than falling back to the raw original on a partial match.
- Pseudonymizes identifiers that appear in filenames (e.g. `…-A000000.csv`); the
  mapping lives only in the manifest.

### Reliability

- **Only files 2 MB or smaller are inspected, transformed, or OCR'd.** A larger file
  (a big PDF, export, or log) is passed through to Claude Code as-is with a warning
  ("over the 2 MB inspection limit — review before sharing") instead of being loaded
  into memory. This prevents a single large file from hanging or exhausting memory
  during preparation. Large files are always delivered, never held back.
- `.DS_Store` and other OS-generated files no longer fail preparation: their background
  churn is excluded from the source-integrity check (they are still delivered). Genuine
  integrity/attack shapes still fail closed, and a failure now names the changed files
  in Yuhi Output.
- The preparation-failure dialog now offers Switch Workspace (alongside Retry, View
  Yuhi Output, and Cancel) so a failed run never traps you. A running preparation stays
  cancellable from its progress notification.
- Local PDF summaries run only when Ollama is reachable with a model installed; when
  not, `document-index.md` states the reason honestly instead of a silent zero.

## [0.2.4]

### Intelligent Preparation

- Adds local PDF text-layer extraction before preparation.
- Falls back to local page rendering and Tesseract OCR when available.
- Scans extracted text in memory for secret-like and personal information.
- Generates local document summaries with Ollama and rescans every generated
  summary before inclusion.
- Creates `.yuhi/context/document-index.md` as the agent's initial document map.
- Shows separate document-inspection, context-generation, and estimated-context
  metrics in Review Prepared Context.
- Stores document inspection counts and methods only; extracted/OCR text is
  never written to manifests, sessions, logs, or audit records.
- Keeps Recommended one-click behavior: documents that cannot be inspected are
  included unchanged with a transparent warning, while unresolved credentials
  remain local.

Development preview. Local tools must be installed for PDF extraction and OCR;
no document content is uploaded by Yuhi.

## [0.2.3]

### Safe Agent Execution

- Positions Yuhi as a protected AI-agent workspace: prepare, run, review changes, and apply safely.
- Continues with explicitly labelled unverified PDF, image, binary, and unknown
  binary files instead of treating inspection limitations as preparation
  failures.
- Keeps credential files and private-key material protected: Yuhi creates a
  verified sanitized copy when supported; otherwise the raw file is not
  included.
- Tracks created, modified, deleted, and renamed files after an agent works in a Prepared Workspace.
- Rescans changed output before Apply and blocks secrets, personal data, uninspectable output, and source conflicts.
- Adds **Yuhi: Review Agent Changes** with explicit diff review and Apply confirmation.
- Stores metadata-only apply audit records. Source code, findings, and secret values are not persisted.
- Never applies agent changes automatically. Changes to transformed inputs remain non-applicable until a safe reverse-transform workflow exists.

Development preview. The fixed 0.2.2 preparation policy and launch guarantees remain unchanged.

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
