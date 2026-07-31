# Release: Yuhi 0.3.0 — AI-ready repositories + shareable Repository Report

Merges the 0.3.0 release branch into `main`. This is the record of the release;
`main` was **fast-forwarded** to the release branch (no merge commit).

Positioning: **"Turn any repository into an AI-ready repository."** One command:
`npx @yuhi-ai-labs/yuhi prepare`. 0.3.0 adds a **public-safe Repository Report**
and a read-only **"What the AI Can See"** review.

- CLI (`@yuhi-ai-labs/yuhi`): **0.3.0**
- VS Code extension (`yuhi-vscode`): **0.3.0** — displayName **"Yuhi — AI-Ready Repositories"**

## What changed by area

### CLI (`packages/core`, `apps/cli`)

- **Repository Report** (`yuhi report <run> --format terminal|markdown|json|svg`),
  built from the preparation numbers and embedded in the prepared session; it now
  leads the `yuhi prepare` output.
- Every format is **public-safe** — aggregate numbers only (Source files, Prepared
  artifacts, Documents prepared, Secrets blocked, Identifiers transformed,
  Estimated accessible-content reduction). No filename, path, secret type, or
  identity.

### VS Code (`apps/vscode`)

- **Repository Ready card** with the concrete outcomes, plus **Copy public
  report** and **Export…** (Markdown / JSON / SVG badge).
- **What the AI Can See** — read-only review: Available vs Unavailable to the AI,
  buckets (prepared/transformed, included unchanged, excluded by user, excluded by
  policy, kept local because verification failed), per-file "Claude receives" +
  reason + Original ↔ Prepared diff, a filter, and Safety Mode / Context Detail as
  **display-only labels**.

### CI (`actions/yuhi-report`)

- **Report-only GitHub Action**: writes the report to the Actions **Job Summary**
  and uploads `yuhi-report.json`. Never fails the build, no PR comments,
  `contents: read` only.

### Docs

- Adoption-first READMEs (root + **ja** + **zh-CN** + CLI + VS Code Marketplace
  copy). Extension displayName updated to **"Yuhi — AI-Ready Repositories"**.
- **Corrected document capabilities**: PDF / DOCX / DOCM / PPTX / PPTM are
  converted to sanitized Markdown companions (originals never shared) — shipped in
  0.2.9, now documented correctly. The old "PDF not supported" limitation was
  false and has been removed.
- CHANGELOG `[0.3.0]` entry added.

### Folded-in main hotfixes

- **0.2.6** — privacy hardening + large-workspace reliability (a single
  problematic file never fails the whole preparation; same isolation on the final
  rescan).
- **0.2.8** — a generated file can never fail the whole run, plus failure
  diagnostics.

## Verification checklist

All passed prior to merge:

- [x] **519 tests green.**
- [x] **Typecheck clean.**
- [x] **VSIX and `npm pack` contain no source, no tests, and no secrets** — and no
  personal name, no local absolute path, and no Claude signature.
- [x] **GitHub Action requests only `contents: read`.**
- [x] **Public report contains no path / email / secret / high-entropy string** —
  verified by property tests.

## Release hygiene

- **No push / publish performed by tooling.** No `git push`, no `npm publish`, no
  `vsce publish`, no GitHub release, and no PR/issue was created by automation as
  part of preparing this. Publishing is a separate, manual maintainer step.
- `main` was **fast-forwarded** to the release branch — this PR body is the record
  of that merge.

## Not in this release

Safety Mode / Context Detail **selectors** (display-only labels in 0.3.0), per-file
Include / Exclude, and Apply-and-re-prepare are **not** included — tracked in
**Phase 2b-2b: Repository Ready controls**. `yuhi run` / `yuhi open` remain
disabled (use the VS Code handoff). Local AI (Ollama summaries) is optional;
Codex / Gemini adapters are planned; an OS sandbox is not implemented.

## Disclaimers

Reduction is an **estimate** of agent-accessible content, **not** token or cost
savings. Yuhi is **not** an OS sandbox. Org is **YUHI-AI-Labs**.
