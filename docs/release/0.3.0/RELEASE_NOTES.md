# Yuhi 0.3.0 — release notes

**Turn any repository into an AI-ready repository.** One command:

```bash
npx @yuhi-ai-labs/yuhi prepare
```

0.3.0 is the **shareable-report** release. Yuhi already prepared a smaller,
cleaner, safer workspace before your coding agent saw it — now it hands you a
**public-safe Repository Report** of exactly what it did, and a read-only view of
**what the AI can and can't see**.

- **CLI (npm):** `@yuhi-ai-labs/yuhi` **0.3.0**
- **VS Code (Marketplace):** `yuhi-vscode` **0.3.0** — displayName **"Yuhi — AI-Ready Repositories"**

---

## What's new

### CLI

- **Repository Report** — `yuhi report <run> --format terminal|markdown|json|svg`.
  Concrete, measurable outcomes you can share: **Source files**, **Prepared
  artifacts**, **Documents prepared**, **Secrets blocked**, **Identifiers
  transformed**, and the **estimated accessible-content reduction**.
- Every format is **public-safe** — aggregate numbers only, never a filename,
  path, secret type, or identity — so it is safe to paste into a README, a PR, or
  a post.
  - `--format markdown` — a table for your README or PR.
  - `--format json` — machine-readable, for CI.
  - `--format svg` — a "Prepared with Yuhi — 94% reduced" badge.
- The report is embedded in the prepared session and now leads the `yuhi prepare`
  output:

  ```text
  Repository Ready

    Source files             5,224
    Prepared artifacts         317
    Documents prepared          42
    Secrets blocked             18
    Identifiers transformed    103

    Estimated accessible-content reduction: 94%

  Ready for Claude Code.
  ```

### VS Code

- **Repository Ready card** — after a successful prepare, the review panel shows
  the same concrete outcomes at the top of the panel.
- **Copy public report** copies the Markdown report to the clipboard;
  **Export…** saves it as **Markdown**, **JSON**, or an **SVG badge**. Every
  format is public-safe.
- **What the AI Can See** — a read-only review below the card that makes "what the
  AI can see, and what stays on your machine" obvious at a glance:
  - **Available to the AI** vs **Unavailable to the AI**, split into
    prepared/transformed, included unchanged, excluded by user, excluded by
    policy, and kept local because verification failed.
  - Each file shows what **Claude receives** (nothing / unchanged / transformed),
    the reason, and an **Original ↔ Prepared diff** where available.
  - A filter narrows the list. The applied **Safety Mode** and **Context Detail**
    are shown as **display-only labels** in this release.
  - This is review-only — file paths shown here never enter the copied or exported
    report.

### CI

- **Report-only GitHub Action** (`actions/yuhi-report/`) — writes the Repository
  Report to every run's **Job Summary** and uploads `yuhi-report.json` as an
  artifact. It is report-only by design: it **never fails the build** by default,
  **never posts PR comments**, and needs only `permissions: contents: read`.

### Docs

- **Adoption-first READMEs** — the root README (plus **ja** and **zh-CN**), the
  CLI README, and the VS Code Marketplace copy now lead with preparation outcomes
  and the "AI-ready repository" positioning. The extension displayName is now
  **"Yuhi — AI-Ready Repositories"**.

---

## Document companions — corrected

PDF / DOCX / DOCM / PPTX / PPTM documents are converted **locally** to sanitized
Markdown companions; the **original binary is never shared** with the agent and
the source file is never modified. This capability shipped in **0.2.9** — 0.3.0
documents it correctly. The earlier "PDF not supported" limitation was **false**
and has been removed from the READMEs.

---

## Folded-in main hotfixes

0.3.0 also carries forward earlier reliability and privacy fixes from `main`:

- **0.2.6 — reliability & privacy hardening.** A single problematic file never
  fails the whole preparation: each file is processed in isolation, and if one
  cannot be read or processed it is skipped with a note while preparation
  continues. The same isolation applies to the final privacy rescan.
- **0.2.8 — a generated file never fails the whole run.** Yuhi's own generated
  handoff file could previously trip its rescan (e.g. on a long high-entropy
  filename) and abort an already-completed preparation. Yuhi now sanitizes the
  generated handoff and always writes it. This ships alongside the failure
  diagnostics that write the actual error (type/code, source paths redacted) to
  Yuhi Output with a modal recovery dialog.

---

## Not in this release / coming next

These are **not done** in 0.3.0 — do not read them as shipped:

- **Safety Mode / Context Detail selectors.** In 0.3.0 these are **display-only
  labels**; you cannot yet change them.
- **Per-file Include / Exclude** decisions from the review.
- **Apply and re-prepare** from the review.

They are tracked for **Phase 2b-2b: Repository Ready controls** (see the issue
draft in this folder).

Also optional or planned, not part of this release:

- **Local AI (Ollama summaries)** is optional; core preparation is deterministic
  and runs without a model.
- **`yuhi run` / `yuhi open`** remain disabled — use the **VS Code handoff** for
  the Claude Code launch in this release.
- **Codex / Gemini adapters** are planned.
- **An OS-level sandbox** is not implemented.

---

## Honest disclaimers

- **Reduction is an estimate.** "Estimated accessible-content reduction" measures
  how much of your repository is made accessible to the agent — **not** model
  token usage, billing, or cost, which differ due to system prompts, tool output,
  conversation history, and caching.
- **Yuhi is not an OS sandbox.** It controls the *inputs* an agent starts from. It
  does not confine the agent's filesystem at the OS level or block its network
  traffic; a launched agent may still access paths outside the Prepared Workspace
  if its runtime or you permit it. See
  [`docs/THREAT_MODEL.md`](../../THREAT_MODEL.md).
- Your **original files are never modified**. Preparation and review run entirely
  on your machine — no telemetry, no account.
