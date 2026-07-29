# Yuhi — Roadmap

> **Yuhi prepares the right context before an AI starts. Everything else is an extension.**

This roadmap is the honest answer to "is this project alive?" It is grouped by
what is **done**, what is **in progress**, what is **next**, and what is **future**.
For the finer-grained per-feature status, see the table in the [README](../README.md).

_Last reviewed: 2026-07._

---

## ✅ Completed — v1.0 (release candidate)

**Core**
- pnpm + TypeScript monorepo; UI-agnostic core (no editor dependency).
- Declarative policy (`yuhi.yaml`) with JSON-Schema validation.
- Policy engine: glob matching, gitignore-style negation, most-restrictive-wins precedence.
- Scanner: deterministic secret detectors + entropy + binary/symlink flags.

**Routes (the whole vocabulary)**
- **Send directly**, **Remove secrets** (deterministic redaction), **Prepare locally**,
  **Runtime only** (env injection, never in context), **Keep local**, **Exclude**.
- **Prepare locally** runs for real: `pseudonymize` → `safety-check` processors,
  on-device, with the original file left untouched.

**CLI**
- `init · scan · preview · explain · diff · status · run · doctor`,
  plus `workspace` and `audit` subcommands.
- `--json`, `--quiet`, `--no-color`, `--lang en|ja|zh-CN` everywhere.
- Secure workspace generator: copy, transform, manifest, path-traversal & symlink guards.
- `dummy` (offline) and Claude Code adapters.
- Local, metadata-only audit log (never stores file contents).

**VS Code extension**
- Preview webview using the same route vocabulary as the CLI.
- Explorer badges, status bar (`N sent · N prepared · N kept`), follow-active-file.
- Reveal-what-AI-sees diff, explain-file, run agent.

**Project**
- Apache-2.0; `NOTICE` (trademark); community-health docs (`CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`).
- Unit + integration + security regression tests (all green).
- READMEs (en/ja/zh-CN); product website.

---

## 🚧 In progress — road to public v1.0

- CI matrix (Linux/macOS/Windows), CodeQL, secret scan, Dependabot — workflows in `.github/`.
- Release automation: version tags, checksums, npm + VS Code Marketplace publish.
- Documentation polish and a first-run tutorial.
- Public-release review (security, first impressions, contributor onboarding).

---

## ⏭️ Next — v1.1 "Local AI"

The flagship of v1.1 is **Prepare locally with a local model**. Goal: demonstrate the
architecture cleanly, not support every model.

- `LocalModelProvider` — a generic interface; the RouteExecutor never hardcodes a vendor.
- `OllamaProvider` — the first provider, via Ollama's OpenAI-compatible chat endpoint.
- `summarize-local` processor (txt / md / csv / json) → a concise, sendable summary.
- **`safety-check` runs after summarization**; if protected values remain, transmission is blocked.
- Everything stays on the machine — no cloud calls. Default model `gemma3:4b`, fallback `qwen3:4b`, configurable.
- Docs: **Preparing Context with Local AI** (why local, why summarize, privacy limits, supported models).

---

## 🔭 Future — v1.2 and beyond

- **v1.2** — Processor Registry + community processors; SDK for third-party processors/adapters;
  `metadata-only` action; **Context Preparation Benchmark (ContextBench) α** (see [RESEARCH.md](./RESEARCH.md)).
- More agents — Codex CLI, Gemini CLI, generic command adapter.
- **Research toward optional sandbox backends** — Docker, `sandbox-exec`, bubblewrap/namespaces,
  Windows Sandbox; read-only mounts / network namespaces (see [THREAT_MODEL.md](./THREAT_MODEL.md)).
- Tamper-evident audit log; signed releases / provenance.
- **v2.0** — team/enterprise policy, optional hosted collaboration, processor marketplace.

---

## Non-goals (by design)

Yuhi is **not** a sandbox, **not** an API gateway, **not** a secrets vault, and ships
**no telemetry**. It controls the *inputs* an agent starts from — see
[THREAT_MODEL.md](./THREAT_MODEL.md) for exactly what that does and does not cover.

Have an opinion on the order? Open a [Discussion](https://github.com/YUHI-AI-Labs/yuhi/discussions).
