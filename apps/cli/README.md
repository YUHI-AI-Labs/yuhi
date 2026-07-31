# yuhi

> **Turn any repository into an AI-ready repository.**

**Website:** [yuhi-iota.vercel.app](https://yuhi-iota.vercel.app/)

`yuhi` is a local-first CLI that prepares a smaller, cleaner, safer workspace before
your AI coding agent sees it — blocking secrets, converting documents to AI-friendly
content, de-identifying tabular data, and reducing the repository to what the agent
actually needs. It then prints a **Repository Report** you can share. **Your original
files are never modified.**

## One command

```bash
npx @yuhi-ai-labs/yuhi prepare
```

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

> Estimates of the initial prepared content — how much of your repository is made
> accessible to the agent — **not** measurements of model token usage or cost.

## Share the result

The report is **public-safe** — aggregate numbers only, never a filename, path, secret
type, or identity:

```bash
yuhi report <run> --format markdown   # a table for your README or PR
yuhi report <run> --format json       # machine-readable, for CI
yuhi report <run> --format svg        # a "Prepared with Yuhi — 94% reduced" badge
```

CI can post it automatically with the
[Yuhi report GitHub Action](https://github.com/YUHI-AI-Labs/yuhi/tree/main/actions/yuhi-report)
(report-only; writes to the Job Summary; no write permissions).

## Commands

| Command | What it does |
|---|---|
| `yuhi prepare [dir]` | Prepare a reduced, de-identified copy and print the Repository Report |
| `yuhi report <run> [--format …]` | Print the public-safe Repository Report (terminal / markdown / json / svg) |
| `yuhi init` | Create `yuhi.yaml` (honors `.gitignore`) |
| `yuhi scan` | Local inspection: secrets & sensitive files (never prints values) |
| `yuhi status` | The AI context at a glance, like `git status` |
| `yuhi preview` | Show exactly what an agent would see |
| `yuhi explain <path>` | Why a file is prepared / blocked / kept local |
| `yuhi doctor` | Check your environment & config |

`--json`, `--quiet`, `--no-color`, and `--lang en|ja|zh-CN` are supported everywhere.
Advanced: `yuhi workspace list/inspect/clean`, `yuhi review <run>`.

> After `yuhi prepare`, start Claude Code in the Prepared Workspace that Yuhi generated.
> `yuhi run` / `yuhi open` are temporarily disabled in this preview — use the VS Code
> extension for the one-click Claude Code handoff.

## Honest scope

`yuhi` is defense-in-depth for AI context, **not a sandbox**. It controls the *inputs*
an agent starts from; it does not confine the agent's network or filesystem at the OS
level, and does not guarantee zero leakage. Local-first, no account, no telemetry.

Docs, roadmap, and the full threat model:
**https://github.com/YUHI-AI-Labs/yuhi**

Apache-2.0 · © YUHI AI Labs
