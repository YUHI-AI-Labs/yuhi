<h1 align="center">Yuhi</h1>

<p align="center"><strong>Turn any repository into an AI-ready repository.</strong></p>

<p align="center">Yuhi prepares a smaller, cleaner, safer workspace before your coding agent sees it — then lets you review what the AI can see and share a public-safe summary of what it did.</p>

<p align="center"><strong>Yuhi creates a protected workspace for AI agents, monitors changes, and helps you safely apply results.</strong></p>

> **Current release: 0.4.0** — **Dynamic Context Runtime.** Claude Code runs through a local Yuhi gateway: every new tool result is stored privately, scanned, compressed and re-scanned before it reaches the provider, and everything withheld stays retrievable. Defaults to **Developer Mode** — see [Dynamic context (v0.4.0)](#dynamic-context-v040).

<p align="center">
  <a href="https://www.npmjs.com/package/@yuhi-ai-labs/yuhi"><img alt="npm" src="https://img.shields.io/npm/v/@yuhi-ai-labs/yuhi?label=npm&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/yuhi-ai-labs.yuhi-vscode?label=VS%20Code&color=007ACC&logo=visualstudiocode&logoColor=white"></a>
  <a href="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YUHI-AI-Labs/yuhi/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

<p align="center">🌐 Also in <a href="./README.ja.md">日本語</a> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <img alt="Yuhi — yuhi status → preview → prepare, Repository Ready in one command" src="docs/demo.gif" width="820">
</p>

<!-- Animated demo. Regenerate with `vhs docs/demo.tape` (writes docs/demo.gif); static fallback is docs/preview.png. Same asset is reused on the product site. -->

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

## Prepare once. Run with Claude or Codex.

One prepared repository is reusable across agents — the same safe copy, the same
deterministic **Context ID**, no re-scan or re-preparation to switch:

```bash
yuhi prepare                 # prepare once
yuhi launch claude           # ...then run Claude Code in the prepared repo
yuhi launch codex            # ...or Codex — same prepared repository
```

In VS Code, the review shows **Launch with [ Claude Code ] [ Codex ]** with each agent's
availability and the run's Context ID. Yuhi stays agent-agnostic: it prepares and secures
the context; the agent you choose is what talks to the model.

Yuhi Mode keeps Claude Code capabilities user-selectable (Standard, Plan, Accept
Edits, Auto, or Custom) and offers Standard, Guarded, and Locked Down sandbox
presets. Guarded is the default and does not disable Auto mode globally.

Context Compression defaults to **Auto (Recommended)** with a best-effort 200,000
token target. Safe compact representations are additive: the full original remains
available, and parser or verification failures fall back to FULL rather than removing
useful files.

## Progressive Context — start fast, context gets better in the background

Yuhi's job is to get you into Yuhi Mode *fast*, so heavy preparation — PDF/DOCX extraction,
OCR, local summarization — never blocks launch. Those steps are **deferred to a persistent
background queue** that runs *after* Yuhi Mode is ready. Foreground wall-time doesn't grow
with how much heavy work is pending.

- **Safety-gated, atomic publish.** A background result is normalized, pseudonymized, and
  safety-inspected *before* anything is written; only a verified, sanitized companion is
  published (atomically) into the agent-visible workspace. A result carrying a secret or PII
  is **kept local** — the original source and raw document are never delivered.
- **Immutable Context ID + incrementing Context Revision.** The base **Context ID** never
  changes as background work completes; each safely-published artifact bumps a deterministic
  **Context Revision** (`revisionId`) that folds in the base Context ID plus the published
  set. It's time-, path-, machine-, user-, and **agent-independent** — Claude and Codex reuse
  the *same* prepared run and compute the *same* revision, with no re-scan or re-preparation.
- **VS Code**: the panel honestly shows background progress with **Cancel** and **Refresh
  Context**. **CLI**: `yuhi background` reports status and can start / cancel / retry.
- **Private-state boundary.** The queue's private records, staging bytes, and cancel flags
  live *outside* every agent-visible root (under the managed base); the agent reads only a
  single path-safe public status file.

## Safe Patch Review — review first, apply safely

Yuhi keeps agent work isolated in the Prepared Repository until you explicitly approve it.
After Claude Code or Codex changes files, Yuhi shows what changed, masks sensitive diff
content, and lets you select eligible files or text hunks.

Before every Source write, Core reloads the private pre-agent snapshot and rechecks the
Prepared Working Tree identity, Source hashes, path containment, symlinks, representation,
secrets, PII, and sensitive configuration. Apply uses private backups, atomic replacement,
verified rollback, and transactional Undo. Compressed files, background artifacts, binary
changes, mode changes, credentials, and source conflicts remain blocked.

```bash
yuhi patch status
yuhi patch diff
yuhi patch validate
yuhi patch apply
yuhi patch undo <patch-id>
yuhi patch history
```

Yuhi never auto-applies, commits, pushes, or opens a pull request.

## See how much of your repository your AI actually needs

Coding agents start inside your working tree and can read everything there — `.env` files,
cloud credentials, customer data, giant build artifacts, binary blobs. Most of it isn't
context the agent needs; some of it is context it shouldn't have.

Yuhi answers a simple question — *how much of this repository should the AI really see?* —
and then prepares exactly that:

- **Blocks secrets during preparation.** In `yuhi prepare`, credentials and private keys are neutralized locally and never handed to the agent. The v0.4.0 dynamic runtime is different by design — see [Dynamic context (v0.4.0)](#dynamic-context-v040) below.
- **Converts documents to AI-friendly content.** Supported documents (PDF / DOCX / PPTX) gain sanitized Markdown companions in the background. Balanced can make an original available with an explicit inspection-pending warning; Maximum Privacy keeps unverified originals local.
- **Reduces the repository to what matters.** Oversized and irrelevant files are kept local; files Yuhi can't safely inspect are either kept local or included with an explicit *unverified* warning.
- **Prepares your workspace in one command.** Then start Claude Code from the VS Code extension.

## Native Claude GUI (v0.4.1)

**Yuhi: Open Claude Code Dynamic Workspace** opens the **official** Anthropic Claude Code
extension in an isolated VS Code window whose `claude` process talks through the Yuhi
gateway. You get the normal Claude Code GUI, with tool output compressed, recorded and
policy-checked on the way past.

- Your **normal VS Code profile and windows are untouched**. The session runs in its own
  `--user-data-dir` and `--extensions-dir`.
- The endpoint is set through the official, documented `claudeCode.environmentVariables`
  setting, merged with whatever is already there.
- **Yuhi never reads, copies, or stores your Claude credentials.** If the isolated window
  needs a sign-in, you sign in through the official extension's own UI.
- Closing the window ends the session and stops its gateway. `yuhi dynamic sessions`,
  `yuhi dynamic stop <id>` and `yuhi dynamic recover` handle anything left behind.

**macOS only, verified.** Linux and Windows are implemented but not verified on real GUIs;
remote environments (SSH, WSL, Dev Containers, Codespaces) are not supported and say so —
use Dynamic Terminal Mode there. The isolated window runs with workspace trust disabled,
because VS Code's Restricted Mode would otherwise disable both Claude and Yuhi in it; this
applies only to the window Yuhi opens on a workspace Yuhi prepared.

Details: [docs/design/V0_4_1_NATIVE_GUI.md](docs/design/V0_4_1_NATIVE_GUI.md) ·
[docs/V0_4_1_RELEASE_SCOPE.md](docs/V0_4_1_RELEASE_SCOPE.md).

## Dynamic context (v0.4.0)

`yuhi launch claude --dynamic-context` — or **Yuhi: Start Claude Code with Dynamic Context**
in VS Code, which uses a dedicated terminal rather than the GUI above — routes Claude Code
through a local gateway. Each new tool result is stored
privately, scanned, compressed and re-scanned before it reaches the provider, and everything
withheld stays retrievable.

Measured on a real edit-and-verify loop (Claude Code, haiku, n=3, provider-reported usage):
correct patches 3/3, input-side tokens −22%, provider cost −13%, delivered tool output −70%.
*Results vary by task, model, cache behaviour, and retrieval configuration.*

### Developer Mode

The dynamic runtime defaults to **Developer Mode**, which changes what a detected secret
means — and this is a deliberate reversal of the preparation-time default above:

- Claude Code **may use project configuration, including `.env`**. An agent that cannot read
  configuration cannot diagnose configuration.
- **Raw secret values are excluded from Yuhi logs, evidence, statistics, and UI.** Only the
  type, a count, and a non-reversible fingerprint are recorded.
- **Private keys, certificates, recovery keys and seed phrases are masked in every mode** —
  span-level, so the rest of the file still reaches the agent.
- **Direct re-exposure is detected and audited where possible**: a delivered value
  reappearing in a response, a patch, a commit body or an outbound request is recorded.
- **Egress detection is a tripwire, not a complete prevention control.** It matches literal
  values; a paraphrased or re-encoded secret is not detected.
- **Strict Mode is selectable today** — `--delivery-mode strict` (CLI) or
  `yuhi.dynamicContext.deliveryMode` (VS Code). Strict Mode masks detected secrets and supported identifiers before delivery. Detection coverage depends on file format and content. It is not a guarantee that every
  secret or identifier is removed: record-level pseudonymization applies to tabular files
  (`.csv` / `.tsv` / `.xlsx`), and a number with no surrounding context in a plain text file
  is not distinguishable from any other number.

`yuhi prepare` and its Safety Modes are unchanged. Details:
[docs/design/V0_4_0_DEVELOPER_MODE.md](docs/design/V0_4_0_DEVELOPER_MODE.md) ·
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

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

**On the CLI** — `yuhi prepare` and `yuhi report` are available today. Agent launch is currently supported through the VS Code extension.

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

- [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) — what Yuhi does and does **not** protect against.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the codebase is structured.

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and
[`CODE_OF_CONDUCT.md`](./docs/CODE_OF_CONDUCT.md). Adding an agent is often just a config entry;
adding a secret detector is a small, testable change.

## License

[Apache-2.0](./LICENSE) — © Yuhi contributors. No telemetry. Local-first. Vendor-neutral.
