<h1 align="center">Yuhi</h1>

<p align="center"><strong>Turn any repository into an AI-ready repository.</strong></p>

<p align="center">Yuhi prepares a smaller, cleaner, safer workspace before your coding agent sees it — then lets you review what the AI can see and share a public-safe summary of what it did.</p>

<p align="center"><strong>Yuhi creates a protected workspace for AI agents, monitors changes, and helps you safely apply results.</strong></p>

> **0.2.4 development theme — Intelligent Preparation**
>
> 0.2.2: Prepare safely. 0.2.3: Work safely with AI agents. 0.2.4:
> inspect and organize document context locally before handoff.

0.2.4 adds local PDF extraction, OCR fallback, Ollama document summaries,
summary security verification, and a `.yuhi/context/document-index.md` entry
point. Extracted document text remains memory-only; generated summaries are
included only after deterministic rescanning.

Yuhi Recommended prioritizes a usable Prepared Workspace while making
uncertainty visible. Credential files and private-key material are never copied
unchanged. Supported CSV/TSV/XLSX tables and credential configuration are
transformed locally and verified before inclusion. PDF, image, binary, and
unknown binary formats that Yuhi cannot inspect are included unchanged with an
**Unverified files included** warning; Claude Code may read those files. Review
them before using Yuhi with sensitive information.
>
> Prepared Workspace → Agent execution → Change review → Apply safely. Agent
> changes are never applied to the Original Workspace automatically.

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm (beta)" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi/beta?label=npm%20%40beta&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-vscode?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

<p align="center">🌐 Also in <a href="./README.ja.md">日本語</a> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img alt="Yuhi — every file's route at a glance" src="docs/preview.png" width="760">
</p>

<!-- Static preview of `yuhi preview`. For an animated GIF, run `vhs docs/demo.tape` → writes docs/demo.gif (see docs/DEMO.md), then swap the src above. -->

---

## One command

```bash
npx @yuhi-ai-labs/yuhi prepare
```

Yuhi inspects your repository locally, prepares a reduced and de-identified copy, and
prints a **Repository Report** — concrete, measurable outcomes you can share:

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

> These are **estimates of the initial prepared content** — how much of your repository is
> made accessible to the agent — **not** measurements of model token usage or cost. Your
> original files are never modified.

## See how much of your repository your AI actually needs

Coding agents start inside your working tree and can read everything there — `.env` files,
cloud credentials, customer data, giant build artifacts, binary blobs. Most of it isn't
context the agent needs; some of it is context it shouldn't have.

Yuhi answers a simple question — *how much of this repository should the AI really see?* —
and then prepares exactly that:

- **Blocks secrets.** Credentials and private keys are neutralized locally and never handed to the agent.
- **Converts documents to AI-friendly content.** PDF / DOCX / PPTX become sanitized Markdown companions; the original is never shared.
- **Reduces the repository to what matters.** Oversized, binary, and irrelevant files are kept local, not sent.
- **Prepares Claude Code in one command.** Point your agent at the Prepared Workspace and start.

## Share the result

The report is the point. Every format is **public-safe** — aggregate numbers only, never a
filename, path, secret type, or identity — so it's safe to paste into a README, a PR, or a post:

```bash
yuhi report <run> --format markdown   # a table for your README or PR
yuhi report <run> --format json       # machine-readable, for CI
yuhi report <run> --format svg        # a "Prepared with Yuhi — 94% reduced" badge
```

Drop the badge in your README:

```bash
yuhi report <run> --format svg > .github/yuhi-badge.svg
```

```md
![Prepared with Yuhi](.github/yuhi-badge.svg)
```

Or let CI post it automatically — the [Yuhi report GitHub Action](./actions/yuhi-report)
writes a **Repository Report** to every run's Job Summary (report-only; no PR gate, no write permissions).

## Open Claude Code

**In VS Code** — install the
[Yuhi extension](https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode)
and run **`Yuhi: Prepare and Start Claude Code`**. Yuhi prepares and reviews the workspace,
then opens the Prepared Workspace in a new window marked **Prepared by Yuhi** for the official
`anthropic.claude-code` extension.

**On the CLI** — after `yuhi prepare`, start Claude Code in the Prepared Workspace that Yuhi
generated. Your agent now works from prepared context; your original files stay untouched.

> Yuhi prepares *initial context*. It is **not** an OS-level sandbox: an agent may still access
> paths outside the Prepared Workspace if its runtime or you permit it. See
> [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md).

## How it works

```text
Scan   →  inspect the repository locally for secrets, PII, documents, and noise
Prepare→  neutralize secrets, de-identify tables, convert documents, drop what isn't needed
Verify →  rescan the delivered artifacts before anything is handed off (fail-closed)
Report →  a public-safe Repository Report — terminal / Markdown / JSON / SVG
```

Everything runs **on your machine**. No telemetry, no account, works offline. Your original
files are read-only to Yuhi; the prepared copy lives under a managed workspace directory.

## What Yuhi is — and is not

Yuhi is **defense-in-depth for AI context, not a sandbox.** It controls the *inputs* an agent
starts from. It does **not**:

- intercept or block the agent's network traffic (whatever the agent sends to its model provider is outside Yuhi's control);
- confine the agent's filesystem at the OS level (a determined agent process can still open absolute paths or walk `..`);
- guarantee zero data leakage.

We deliberately avoid claims like "100% secure" or "guaranteed no leakage." See
[`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for the full model and the roadmap toward
optional sandbox backends (Docker, `sandbox-exec`, bubblewrap, Windows Sandbox).

## Commands

| Command | What it does |
|---|---|
| `yuhi prepare [dir]` | **The one command** — prepare a reduced, de-identified copy and print the Repository Report |
| `yuhi report <run> [--format …]` | Print the shareable, public-safe Repository Report (terminal / markdown / json / svg) |
| `yuhi init` | Create `yuhi.yaml` (honors `.gitignore`, `.dockerignore`, …) |
| `yuhi scan` | Local inspection: secrets & sensitive files (never prints values) |
| `yuhi status` | The AI context at a glance — like `git status` |
| `yuhi preview` | Show exactly what an agent would see |
| `yuhi explain <path>` | Why a file is prepared, blocked, redacted, or kept local |
| `yuhi doctor` | Check your environment & config |

`--json`, `--quiet`, `--no-color`, and `--lang en|ja|zh-CN` are supported everywhere.
Advanced: `yuhi workspace list/inspect/clean`, `yuhi review <run>`, and `yuhi audit list/show/export`.

> The npm package is **`@yuhi-ai-labs/yuhi`** (current release is a **beta** dist-tag — pin it with
> `@yuhi-ai-labs/yuhi@beta`). To build from source: `pnpm install && pnpm build`, then
> `node apps/cli/dist/index.js`.

## The policy: `yuhi.yaml`

A small, declarative file (validated by `schemas/yuhi.schema.json` — editor autocomplete works
out of the box). Sensible defaults ship in the file `yuhi init` writes; you rarely need to edit it:

```yaml
version: "1"
defaults:
  action: allow
rules:
  - name: block-env
    match:
      paths: ["**/.env", "**/.env.*", "!**/.env.example"]
    action: block
  - name: redact-secrets
    match:
      detectors: [api-key, access-token, private-key]
    action: redact
  - name: keep-customer-data-local
    match:
      paths: ["customer-data/**"]
    action: local-only
```

When multiple rules match, **the most restrictive wins**, and any detected secret escalates a
file to at least `redact`.

## Architecture

A pnpm + TypeScript monorepo. The core is UI-agnostic (no VS Code dependency):

```
packages/  shared · config · policy · scanner · processors · workspace · agents · audit · core
apps/      cli · vscode
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and `docs/adr/`.

## Project direction

- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — done / in progress / next / future.
- [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — what Yuhi does and does **not** protect against.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the codebase is structured.

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md). Adding an agent is often just a config entry;
adding a secret detector is a small, testable change.

## License

[Apache-2.0](./LICENSE) — © Yuhi contributors. No telemetry. Local-first. Vendor-neutral.
