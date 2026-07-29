# Yuhi — Local AI Prep (VS Code)

**Prepare your workspace on-device before anything is sent to Claude.**

**Website:** https://yuhi-iota.vercel.app/

Yuhi runs a small **local** model (via [Ollama](https://ollama.com)) to summarize and
reduce your files, mask sensitive values, and run a deterministic safety check — all on
your machine. You then **review** exactly what would be sent, as an Original ↔ Prepared
diff, before any of it leaves your computer. Your original files are never modified.

> Beta. This extension focuses on the local **preparation + review** step. It does **not**
> forward anything to Claude for you — the review step is the deliberate stopping point.

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

Apache-2.0 licensed. Source and issues:
[github.com/YUHI-AI-Labs/yuhi](https://github.com/YUHI-AI-Labs/yuhi).
