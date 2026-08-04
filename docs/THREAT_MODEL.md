# Yuhi — Threat Model

Status: Draft (v0.1). This document is authoritative for security claims. If marketing
copy and this file disagree, this file wins.

## What Yuhi is

A tool that (1) inspects a repository locally, (2) applies a declarative policy, and
(3) produces a **filtered copy** of the repository in which selected files are omitted
or redacted, then (4) launches an AI agent CLI with its working directory set to that
copy. It is **defense-in-depth against accidental exposure**, not a sandbox.

## What Yuhi is NOT

- **Not an OS/kernel sandbox.** It does not use namespaces, seccomp, sandbox-exec, or
  containers in v0.1. The agent process runs with the same OS privileges as the user.
- **Not a network firewall.** Yuhi does not intercept, inspect, or block the agent's
  outbound network traffic. Whatever the agent uploads to its model provider is
  outside Yuhi's control.
- **Not a filesystem jail.** If the agent chooses to open an absolute path, walk `../`,
  or follow a symlink out of the workspace, the OS permits it. Yuhi controls the
  *starting inputs*, not the agent's syscalls.
- **Not a guarantee.** Forbidden claims: "completely safe", "absolutely no leakage",
  "100% secure", "guaranteed no data leakage".

## Assets

- Secrets/credentials (`.env`, keys, tokens, cloud creds).
- Sensitive documents (customer data, private specs, internal docs).
- **Identifying metadata — the filenames and paths of withheld files.** A real workspace
  names its data after the person in it, so a name is an asset in its own right, not just a pointer to one.
- The integrity of the original repository (must never be modified).
- Audit log integrity (metadata-only).

## Trust boundaries

1. User ↔ Yuhi (trusted local process).
2. Yuhi ↔ generated workspace (Yuhi writes; agent reads/writes).
3. Workspace ↔ agent CLI (agent is semi-trusted: user chose to run it, but it may send
   data to a third party).
4. Agent CLI ↔ model provider (outside Yuhi's boundary entirely).

### Three distinct decision boundaries

These are deliberately separate — see `CLAUDE.md` for the product rationale. Conflating
them (e.g. letting a file-level finding block the launch) is a defect, not a safety feature.

- **File-exclusion boundary (per file).** Each file gets a risk assessment. Safe → included;
  caution/unverified with no concrete finding → included with a warning; high-risk (incl. an
  unresolved credential in a would-be-sent file) → **excluded by recommendation (kept local)**,
  never sent raw. The excluded original is written **only** to the user's machine, never to the
  Prepared Workspace.
- **Workspace-launch boundary (per run).** Launch is allowed whenever a valid Prepared Workspace
  exists and everything actually placed in it is safe. It is blocked **only** by workspace-level
  failure: cannot create the workspace, cannot verify the destination, no usable workspace, an
  internal integrity failure, or the sandbox policy cannot be verified. A file-level exclusion
  **must not** block launch.
- **Explicit-override boundary (user-initiated).** The user may deliberately include an excluded
  file after a one-time risk confirmation. An override is **not** described as safe, sandboxed, or
  confined — it is an informed choice to expose that file's original content to the agent. (The
  Review UI supports per-file and per-type warning inclusion/local-only decisions. Known
  credentials, private keys, and explicit policy blocks still win over warning inclusion.)

### The metadata boundary (v0.3.6)

Withholding a file's bytes is only half of withholding the file. Everything at or below
the prepared root is agent-visible — including `manifest.json`,
`.yuhi/background-status.json`, `.yuhi/session.json`, `.yuhi/yuhi-mode-summary.json`,
`.yuhi/context/AGENT_HANDOFF.md`, `.yuhi/context/document-index.md`, and the names of
any generated context artifact. So Yuhi keeps two layers:

- **Private** (outside every agent-visible root, or in memory for the local UI, which
  shows the user their own filenames): source relpaths, the `originalRelpath` pseudonym
  mapping, provenance `source`, absolute paths, the run/source binding, background queue
  records.
- **Public**: a delivered file keeps the (already de-identified) name the agent can see
  in its tree anyway. A file whose ORIGINAL was withheld appears only as a stable
  `documentId` plus a kind-only `displayName` (`doc-<hex>.pdf`).

Identity — not the name — crosses the boundary, so counts, dedup, and Context Revisions
stay exact while no surface carries the filename. Exclusions are still reported in full;
only the names are gone.

## Threats & mitigations

| # | Threat | Mitigation (v0.1) | Residual risk |
|---|---|---|---|
| T1 | Secret file copied to workspace | Path rules `block`; detector-driven `redact`/`block`; secrets escalate action | Detector misses (novel formats) |
| T2 | Secret value leaks via scan/preview/log output | Never print raw values; mask to `****`; audit stores no content | — |
| T3 | Path traversal in rule/manifest paths | Normalize + confine all writes under workspace root; reject `..` after resolve | — |
| T4 | Symlink escape (link inside repo → outside) | Do not follow symlinks when copying; record & skip; optional materialize-as-marker | Broken links in workspace |
| T5 | TOCTOU (file changes between scan and copy) | Single-pass copy re-checks type with `lstat`; hash recorded in manifest; documented residual | Race with concurrent writer |
| T6 | Shell injection via filenames/args | `spawn` with argv array; never `shell:true`; never string concat | — |
| T7 | Env secret leakage to agent | Child env built explicitly; parent env NOT inherited wholesale; only allow-listed vars passed | User misconfig passes a secret |
| T8 | Original repo modified | Yuhi only writes under `~/.yuhi`; integration test asserts source tree hash unchanged | — |
| T9 | `.git` copied → history/remotes exposed | `preserve_git:false` default; when enabled, warn about history & hooks | User opts in |
| T10 | Git hooks execute in workspace | Hooks not copied by default; documented | User opts in |
| T11 | Malicious filenames (newline, control chars, Windows reserved) | Path normalization + rejection tests; safe rendering | — |
| T12 | Agent reads outside workspace / phones home | OUT OF SCOPE for v0.1 — documented limitation; future sandbox backends | High: inherent to "run the real agent" |
| T13 | Crash leaves temp/partial workspace | Workspaces are self-contained under `~/.yuhi/workspaces/<id>`; `yuhi workspace clean` removes; atomic-ish via temp dir + rename where possible | Orphaned dirs recoverable |
| T14 | Audit log tampering | v0.1 stores plain JSON; tamper-evidence (hash chain/signing) is FUTURE, explicitly not claimed | Local attacker can edit |
| T15 | A withheld file's NAME disclosed through agent-visible metadata (manifest, background status, session, mode summary, handoff, document index, generated artifact names) | Two-layer metadata boundary (`packages/core/src/metadata-boundary.ts`): the source relpath, `originalRelpath` and provenance `source` stay private; a withheld file appears publicly only as `documentId` + a kind-only `displayName`; generated artifacts are named by identity; a redaction pass covers free-text fields; an adversarial byte scan over every agent-visible file asserts zero raw identifiers | Name-shaped data inside a DELIVERED file's own name (de-identified per-token, not semantically) |

## Environment variable policy (T7 detail)

- Default: the child agent process receives a **minimal** environment (PATH, HOME,
  and OS essentials), not the full parent environment.
- Users may explicitly pass required variables (e.g. `ANTHROPIC_API_KEY`) via config
  (`agents.<id>.env_passthrough: [ANTHROPIC_API_KEY]`) or `--env KEY`.
- Yuhi never logs environment values.

## Developer Mode (v0.4.0, dynamic context only)

The dynamic runtime added in v0.4.0 defaults to **Developer Mode**, which changes T2's answer
for tool output — and only for tool output. `yuhi prepare` and its Safety Modes are unchanged.

| | Static preparation (0.3.x, unchanged) | Dynamic context, Developer Mode | Dynamic context, Strict Mode |
|---|---|---|---|
| `.env` / config values reaching the agent | masked or kept local per Safety Mode | **delivered** | masked |
| Private keys, certificates, recovery keys, seed phrases | blocked | **masked, always** | masked |
| Raw value in logs / evidence / stats / UI | never | **never** | never |
| Provider credentials (`ANTHROPIC_API_KEY`, OAuth) | passed to the child process only | passed to the child process only | same |
| A delivered secret appearing in a response, patch, commit or outbound request | n/a | **detected, warned, audited** | same |

What this trades: an attacker who compromises the agent or the provider transcript can read
configuration the developer chose to expose. What it keeps: Yuhi itself never becomes the
place a credential leaks from — no value is written to disk outside the private store, and
none reaches any surface a user might share (evidence, stats, panel, handoff, error text).

Blocking, redaction-before-delivery, approvals and organisation policy are Enterprise Strict
Mode, deliberately not in v0.4.0. The seam exists today: `DeliveryPolicy` is a value the
runtime consumes, and the scanner has no knowledge of modes at all.

## Assumptions

- The user's machine and account are not already compromised.
- The chosen agent CLI is the genuine tool the user intends to run.
- Detector libraries are best-effort; policy `paths` are the primary boundary.

## Future hardening (tracked in ROADMAP, not implemented)

Docker/sandbox-exec/bubblewrap/Windows Sandbox backends, network namespace, read-only
mounts, audit log tamper-evidence, signed releases + SBOM verification.
