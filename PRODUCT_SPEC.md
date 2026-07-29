# Yuhi — Product Specification

Status: Draft (MVP / v0.1). Baseline language: English.

## 1. One-line

**Yuhi decides what AI is allowed to see.** Run any AI coding agent (Claude Code,
Codex CLI, Gemini CLI, …) on your codebase inside a generated, policy-controlled
workspace — without exposing sensitive data and without modifying your repo.

## 2. Problem

AI coding agents are launched directly inside a developer's working tree. That tree
usually contains `.env` files, cloud credentials, customer data, private specs, and
other material the developer does not want handed to a third-party model. Today the
only controls are `.gitignore`-style ignores (which agents may not honor) and trust.
Developers cannot easily **see, before running**, exactly which files an agent will
be able to read.

## 3. Solution

Yuhi sits between the repository and the agent:

1. **Scan** the repo locally (deterministic detectors + secret scanner).
2. **Evaluate** a declarative policy (`yuhi.yaml`) to assign each file an action:
   `allow`, `block`, `redact`, `local-only`, `ask`, `metadata-only`,
   `summarize-local`.
3. **Preview** — show the developer precisely what the agent will and will not see.
4. **Generate** a filtered workspace copy under `~/.yuhi/workspaces/<id>` (original
   repo untouched).
5. **Run** the agent as a child process with its CWD set to that workspace, an
   explicitly-controlled environment, and exit code passthrough.
6. **Audit** the run locally (metadata only — never file contents or secret values).

## 4. Primary user & journey

Individual developer with an existing Git repo. Time-to-value target: **< 5 minutes**.

```
yuhi init       # generate yuhi.yaml + .yuhi/, respecting .gitignore etc.
yuhi preview    # see exactly what the agent can see
yuhi run claude # launch Claude Code inside the safe workspace
```

`yuhi preview` alone must convey the value, even before running an agent.

## 5. Core commands (MVP scope)

| Command | Status | Description |
|---|---|---|
| `yuhi init [--yes]` | Stable | Analyze repo, write `yuhi.yaml` + `.yuhi/`. |
| `yuhi scan [--json]` | Stable | Local inspection; risk summary. Never prints secret values. |
| `yuhi preview [--json] [--agent <a>] [--explain <path>]` | Stable | Show allowed/blocked/redacted/local-only sets + reasons. |
| `yuhi explain <path>` | Stable | Why a single file gets its action. |
| `yuhi workspace create/list/inspect/clean` | Stable | Manage generated workspaces. |
| `yuhi run <agent> [-- ...]` | Stable | Scan → policy → workspace → launch agent. `--` forwards args. |
| `yuhi audit list/show/export` | Stable | Local audit log. |
| `yuhi doctor` | Stable | Environment & config diagnostics. |
| `yuhi version` | Stable | Version info. |

Agents in MVP: `dummy` (bundled, for demos/tests/CI), `claude`. `codex`/`gemini`
adapters land in Phase 2 but the adapter interface exists from Phase 1.

## 6. Policy model

Declarative `yuhi.yaml` (see `schemas/yuhi.schema.json`). Rules match by `paths`
(glob) and/or `detectors`. Action precedence is **most-restrictive-wins** when
multiple rules match, with an explicit precedence order (see ADR-0003). Default
action is configurable (`defaults.action`, default `allow`) — but detector-driven
secrets always escalate to at least `redact`.

Actions:
- `allow` — copied verbatim into the workspace.
- `block` — never copied.
- `redact` — copied with detected secret spans masked (copy only; original untouched).
- `local-only` — excluded from any external-agent workspace (kept for future local pipelines).
- `ask` — prompt interactively; in non-interactive mode fail safe to `block`.
- `metadata-only` — Planned. Emit path/size/type only.
- `summarize-local` — Planned. Replace with a locally-produced summary.

## 7. Non-goals (MVP)

- Not a full OS/network sandbox. Yuhi does **not** intercept the agent's network
  traffic or confine its filesystem at the kernel level.
- Not an API gateway/LLM router. No proxying of model calls in v0.1.
- Not a secret manager or vault.
- Not a guarantee of zero leakage. It is defense-in-depth: it controls the *inputs*
  the agent starts from, not what a determined agent process can reach.
- No telemetry. No account. No network calls by Yuhi itself (offline-capable).

## 8. Security posture (summary; full detail in THREAT_MODEL.md)

Yuhi reduces accidental exposure by (a) never copying blocked/local-only files, and
(b) redacting detected secrets in copies. It does **not** stop a compromised or
adversarial agent from opening `../`, calling out to the network, or reading the
original repo path if that path is passed to it. Forbidden marketing claims:
"completely safe", "100% secure", "guaranteed no data leakage".

## 9. Release criteria (v0.1)

- `yuhi init | scan | preview | run claude` work end-to-end on a real repo.
- Original repo provably unmodified (hash check in integration tests).
- Security regression tests pass (traversal, symlink escape, shell metacharacters,
  env leakage, log leakage).
- Cross-platform CI green (Linux/macOS/Windows, Node 20/22).
- README (en/ja/zh) with a prominent Limitations section.
- Local `npm pack` and VSIX verified (not published).
- Publish checklist complete.
