# yuhi

> **Prepare the right context before AI starts.**

`yuhi` is a local-first CLI that decides — per file — what your AI coding agent
(Claude Code, and more) **sees**, what gets **prepared locally** first (pseudonymize,
mask secrets), and what **never leaves your machine**. It then runs the agent on a
clean, generated copy. **Your original files are never modified.**

```bash
npx @yuhi-ai-labs/yuhi preview      # exactly what the agent would see
npx @yuhi-ai-labs/yuhi run claude   # launch the agent on the prepared context
```

Or install globally:

```bash
npm install -g @yuhi-ai-labs/yuhi
yuhi preview
```

## Why

Launch an agent inside your working tree and it can read everything there — `.env`
files, credentials, customer data, private specs. `yuhi preview` shows every file's
route **before** anything runs; `yuhi run` executes the agent on a filtered copy under
`~/.yuhi/workspaces/<id>`, leaving your repo untouched.

Every file takes one route: **Sent to Claude · Prepared locally · Runtime only · Keep local.**

## Commands

| Command | What it does |
|---|---|
| `yuhi init` | Create `yuhi.yaml` (honors `.gitignore`) |
| `yuhi preview` | The signature command — what the agent will see |
| `yuhi status` | The AI context at a glance, like `git status` |
| `yuhi explain <path>` | Why a file is sent / prepared / kept |
| `yuhi scan` | Local inspection: secrets & sensitive files (never prints values) |
| `yuhi run <agent> [-- …]` | Generate the context and launch the agent |
| `yuhi doctor` | Check your environment & config |

`--json`, `--quiet`, `--no-color`, and `--lang en|ja|zh-CN` are supported everywhere.

## Honest scope

`yuhi` is defense-in-depth for AI context, **not a sandbox**. It controls the *inputs*
an agent starts from; it does not confine the agent's network or filesystem at the OS
level, and does not guarantee zero leakage. Local-first, no account, no telemetry.

Docs, roadmap, and the full threat model:
**https://github.com/YUHI-AI-Labs/yuhi**

Apache-2.0 · © YUHI AI Labs
