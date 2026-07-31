# Yuhi — AI-Ready Repositories (VS Code)

**Turn any repository into an AI-ready repository.** Yuhi prepares a smaller, cleaner,
safer workspace before your coding agent sees it — then shows you a shareable report of
exactly what it did.

YuhiはAIエージェントがリポジトリを見る前に、より小さく・クリーンで・安全なワークスペースを準備し、
その結果を共有可能なレポートとして提示します。

**Website:** [yuhi-iota.vercel.app](https://yuhi-iota.vercel.app/)

Yuhi inspects your repository **locally**, blocks secrets, converts documents to
AI-friendly content, de-identifies tabular data, and reduces the repository to what the
agent actually needs — all on your machine. You then **review** exactly what would be
available, as an Original ↔ Prepared diff, before opening Claude Code. Your original
files are never modified.

> **Early preview. Not yet recommended for production, regulated data, or highly sensitive
> workflows.** Yuhi prepares and reviews the initial context. It never silently submits a
> prompt. A launched agent still has the OS and network access permitted by its runtime.

## Repository Ready

After a successful prepare, Yuhi shows a **Repository Ready** card — concrete, measurable
outcomes you can share:

```text
Repository Ready

  Source files             5,224
  Prepared artifacts         317
  Documents prepared          42
  Secrets blocked             18
  Identifiers transformed    103

  Estimated accessible-content reduction: 94%
```

The report is **public-safe** — aggregate numbers only, never a filename, path, secret
type, or identity. **Copy public report** puts the Markdown on your clipboard; **Export…**
saves it as Markdown, JSON, or an SVG badge — safe to paste into a README, a PR, or a post.

> These are estimates of the initial prepared content — how much of your repository is made
> accessible to the agent — **not** measurements of model token usage or cost.

## Document preparation

PDF, DOCX/DOCM, and PPTX/PPTM documents are converted **locally** to sanitized Markdown
companions; the original binary is never shared with the agent. Text extraction (and OCR
when available for PDFs) is used only for the in-memory security scan and is never stored or
uploaded. When Ollama is available, inspected document text flows through memory to a local
summary generator; Yuhi rescans the generated summary and includes it only when verification
passes. Documents that cannot be safely inspected are delivered as a safe placeholder, never
as raw content.

## Safe agent execution

> Prepared Workspace → Agent execution → Change review → Apply safely

After the agent finishes, run **Yuhi: Review Agent Changes** from the Prepared Workspace.
Yuhi shows metadata-only file changes, rescans generated output, and requires explicit
confirmation before applying verified changes to the Original Workspace. It never applies
changes automatically. Changes to pseudonymized or otherwise transformed source files cannot
currently be applied back, because Yuhi does not persist reversible identity mappings.

## Features

- **Yuhi: Prepare Workspace** (also **Prepare with Yuhi** in the Explorer right-click menu)
  — prepares the workspace locally with progress and cancellation, then shows the Repository
  Ready card. Output is written under `.yuhi/prepared/<runId>/`.
- **Yuhi: Prepare and Start Claude Code** — choose the official `anthropic.claude-code`
  extension or the `claude` CLI. Extension mode opens the Prepared Workspace and asks you to
  start Claude Code from its sidebar or Command Palette; it does not invoke undocumented
  commands or submit a prompt.
- **Yuhi: Review Prepared Context** — the review panel: the Repository Ready card plus a
  Context Savings breakdown (Original vs Prepared **estimated** tokens, the reduction, how
  many files were summarized / excluded / had sensitive values masked, **Source files
  modified: 0**), and a per-file list. Click any prepared file for an Original ↔ Prepared diff.
- **Yuhi: Prepare and Open in New Window** — prepares once, requires review confirmation, and
  opens only `.yuhi/prepared/<runId>` as a new VS Code workspace.
- **Yuhi: Setup Local AI** — optional. If Ollama is missing, points you to the official
  download (it never installs anything for you). Otherwise lets you pick a recommended model
  (`qwen3:1.7b` by default) and, after an explicit modal confirmation, pulls it locally with a
  cancellable progress bar and a smoke test. Local summaries are optional; core preparation
  (secrets, documents, de-identification, reduction) is deterministic and runs without a model.
- **Yuhi: Doctor** — checks the Ollama binary, whether the runtime is reachable, whether your
  configured model is installed, and that `.yuhi` is writable, with one-tap fixes.
- **Prepared by Yuhi indicator** — a persistent shield status item in the generated workspace
  opens the full file-decision review. Generated `.yuhi/session.json` and
  `.yuhi/launch-audit.jsonl` contain metadata only.
- **Status bar** — reflects the current state: *Yuhi ready · Ollama missing · Ollama stopped ·
  Model missing · Preparing… · Ready for review · Preparation failed.*

## Requirements

- A folder open in VS Code with a `yuhi.yaml` policy (the extension offers to create one).
- Optional, for on-device document/table summaries: [Ollama](https://ollama.com/download)
  installed and running with a local model pulled (use **Yuhi: Setup Local AI**).

## What Yuhi is — and isn't

Yuhi prepares what an agent would *start from*. It is **not a sandbox**: any agent you launch
afterwards still has network and OS access. Preparation and review happen entirely locally —
nothing about your code is transmitted during these steps. See the project's
[`THREAT_MODEL.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/THREAT_MODEL.md) and
[`SECURITY.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/.github/SECURITY.md).

- Local-first — preparation runs on your machine.
- No telemetry.
- No external network calls during preparation or review.

## Metric definitions

- **Estimated context / accessible-content reduction** is `(estimated before − estimated
  after) / estimated before`. It measures how much repository content is made accessible to
  the agent — not model token usage or billing, which may differ due to system prompts, tool
  output, conversation history, and caching.
- **Secrets blocked** counts credential/private-key files kept out of the Prepared Workspace.
- **Identifiers transformed** is the sum of structured identifiers de-identified in tables and
  documents.
- **Prepared artifacts** counts the files delivered to the agent; one document can produce a
  companion artifact, so this is reported separately from **Source files**.
- **Documents prepared** counts documents converted to sanitized companions.
- **Sensitive values masked** is the sum of replacements reported by local processors.
- Original source modifications remain **0** after integrity verification.

## Runtime boundary

**Initial context prepared by Yuhi. Claude Code starts in a Yuhi Prepared Workspace.**

- Workspace boundary: advisory
- Workspace-only instruction: enabled
- Filesystem enforcement: not enabled
- OS sandbox: not enabled
- The agent may access files outside the Prepared Workspace if the runtime or user permits it.

Yuhi guarantees the generated initial context and leaves original source files unchanged
during preparation. It does not prevent parent-directory, home-directory, or absolute-path
access after launch.

## Notes and limitations

- Preparation may take time for large workspaces.
- Yuhi prepares initial context but does not provide OS-level filesystem confinement.
- Files that cannot be safely inspected or transformed are kept local, or delivered as a safe
  placeholder for documents; unresolved high-risk files block launch unless you explicitly override.
- CLI agent launch (`yuhi run` / `yuhi open`) is temporarily disabled until it reaches full
  preparation and recovery parity. Use the VS Code workflow for the Claude Code handoff in this
  release.

Sensitivity labels are policy-derived hints, not absolute truth. Yuhi combines explicit
`yuhi.yaml` rules, scanner findings, path/file-type rules, organization policy, and a
conservative fallback. The review shows the winning rule and reason for every file.

Apache-2.0 licensed. Source and issues:
[github.com/YUHI-AI-Labs/yuhi](https://github.com/YUHI-AI-Labs/yuhi).
