# Yuhi — Local AI Prep (VS Code)

**Prepare your workspace on-device before anything is sent to Claude.**

**Website:** https://yuhi-iota.vercel.app/

Yuhi runs a small **local** model (via [Ollama](https://ollama.com)) to summarize and
reduce your files, mask sensitive values, and run a deterministic safety check — all on
your machine. You then **review** exactly what would be sent, as an Original ↔ Prepared
diff, before any of it leaves your computer. Your original files are never modified.

> **Early preview. Not yet recommended for production, regulated data, or highly
> sensitive workflows.** Yuhi prepares and reviews the initial context. It never silently
> submits a prompt.
> A launched agent still has the OS and network access permitted by its runtime.

## Features

- **Yuhi: Doctor** — checks the Ollama binary, whether the local runtime is reachable,
  whether your configured model is installed, and that `.yuhi` is writable, with one-tap
  fixes.
- **Yuhi: Setup Local AI** — if Ollama is missing, points you to the official download
  (it never installs anything for you). Otherwise lets you pick a recommended model
  (`qwen3:1.7b` by default), and — only after an explicit, modal confirmation — pulls it
  locally with a cancellable progress bar and a quick smoke test.
- **Yuhi: Prepare Workspace** (also **Prepare with Yuhi** in the Explorer right-click
  menu) — prepares the workspace locally with progress and cancellation. Output is written
  under `.yuhi/prepared/<runId>/`.
- **Yuhi: Review Prepared Context** — a "Context Savings" panel showing Original vs
  Prepared **estimated** tokens, the reduction, how many files were summarized / excluded /
  had sensitive values masked, **Source files modified: 0**, and a per-file list. Click any
  prepared file for an Original ↔ Prepared diff.
- **Yuhi: Prepare and Open in New Window** — prepares once, requires review confirmation,
  and opens only `.yuhi/prepared/<runId>` as a new VS Code workspace.
- **Yuhi: Prepare and Start Claude Code** — choose the official
  `anthropic.claude-code` extension or the `claude` CLI. Extension mode opens the
  Prepared Workspace and asks you to start Claude Code from its sidebar or Command
  Palette; it does not invoke undocumented commands or submit a prompt.
- **Prepared by Yuhi indicator** — a persistent shield status item in the generated
  workspace opens the full file-decision review. Generated `.yuhi/session.json` and
  `.yuhi/launch-audit.jsonl` contain metadata only.
- **Status bar** — reflects the current state: *Yuhi ready · Ollama missing · Ollama
  stopped · Model missing · Preparing… · Ready for review · Preparation failed.*

## Requirements

- A folder open in VS Code with a `yuhi.yaml` policy (the extension offers to create one).
- [Ollama](https://ollama.com/download) installed and running, with a local model pulled
  (use **Yuhi: Setup Local AI**).

## What Yuhi is — and isn't

Yuhi prepares what an agent would *start from*. It is **not a sandbox**: any agent you
launch afterwards still has network and OS access. Preparation and review happen entirely
locally — nothing about your code is transmitted during these steps. See the project's
[`THREAT_MODEL.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/THREAT_MODEL.md) and
[`SECURITY.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/.github/SECURITY.md).

- Local-first — the on-device model does the preparation.
- No telemetry.
- No external network calls during preparation or review.

## Metric definitions

- **Estimated context reduction** is `(estimated tokens before − estimated tokens after)
  / estimated tokens before`. Actual agent input and billing may differ.
- **Sensitive findings detected** is the number of scanner finding records, not leaks
  and not the number of affected files.
- **Files containing sensitive findings** counts distinct source files with at least one
  finding.
- **Sensitive values masked** is the sum of replacements reported by local processors;
  **files masked** separately counts generated files with one or more replacements.
- **Prepared copies transformed** counts included source-derived files whose generated
  bytes differ from source bytes. Generated metadata, byte-identical copies, and omitted
  files are excluded. Original source modifications remain 0 after integrity verification.
- **Files excluded** are omitted by exclusion/block policy; **kept local** are separately
  omitted by local-only/runtime/ask/metadata-only policy.
- **Unresolved high-risk findings** are findings in files otherwise sent unchanged;
  launch is blocked unless the user explicitly overrides the warning.

Actual agent usage may differ because of system prompts, tool output, conversation history,
and caching.

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

## Known limitations

- PDF parsing and transformation are not yet supported. PDF files are kept local when
  verified inspection is unavailable.
- XLSX safe parsing and transformation are not yet supported. Unsupported or unverified
  workbooks are kept local; unresolved high-risk workbooks block launch.
- Preparation may take time for large workspaces.
- Yuhi prepares initial context but does not provide OS-level filesystem confinement.
- Unsupported or unverified files may be kept local.
- CLI agent launch is temporarily disabled until it reaches full preparation and recovery
  parity. Use the VS Code workflow for Claude Code handoff in this release.

Prepared Workspace metadata uses `schemaVersion: 2`. It keeps finding events, finding-file
counts, masked-value counts, masked-file counts, and byte-different prepared-copy counts
separate. The extension upgrades schema v1 records in memory when opening older Prepared
Workspaces; it does not rewrite them.

Sensitivity labels are policy-derived hints, not absolute truth. Yuhi combines explicit
`yuhi.yaml` rules, scanner findings, path/file-type rules, organization policy, and a
conservative fallback. The review shows the winning rule and reason for every file.

Apache-2.0 licensed. Source and issues:
[github.com/YUHI-AI-Labs/yuhi](https://github.com/YUHI-AI-Labs/yuhi).
