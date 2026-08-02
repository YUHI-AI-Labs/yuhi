# Yuhi v0.3.6

**Safe Patch Review** — *Review first. Apply safely.*

Yuhi prepares a local copy of your repository for an AI coding agent: it decides what the
agent may see, keeps the original untouched, and gets you into Yuhi Mode fast. This release
adds a reviewed path back — agent changes can be applied to your source only after you
approve them — and closes four privacy gaps found in a pre-release audit.

## Safe Patch Review

- Every Claude Code / Codex launch first captures a private, deterministic snapshot of the
  Prepared Workspace. If the snapshot fails, the launch is blocked rather than started
  without change provenance, and another session cannot silently reuse it.
- Created, modified, deleted, renamed, binary, and mode changes are detected in the Prepared
  Repository. Full-text files can be applied by file or by hunk.
- Compressed representations, background artifacts, binaries, mode changes, credentials, PII,
  internal Yuhi metadata, unsafe paths, symlinks, and files changed in your source since the
  snapshot **cannot** be applied.
- Source writes require explicit confirmation and exact-byte revalidation. Apply and Undo use
  private backups with explicit transaction outcomes and never report success before final
  hash verification. Nothing is automatically applied, committed, pushed, or published.
- `yuhi patch status|diff|validate|apply|undo|history|discard` uses the same Core contracts as
  the VS Code UI.

## Security fixes

### Agent-visible metadata boundary

A workspace filename is itself identifying data. Real submissions arrive as
`9999990001 評定-0722.xlsx`, rosters as `名簿-9999990001/`. Withholding such a file's bytes
while publishing its **name** disclosed the identifier anyway.

Yuhi now keeps two layers. The source relpath, the pseudonym mapping, provenance `source`,
absolute paths, and the background queue records stay private — outside every agent-visible
root, or in memory for the local UI, which may show you your own filenames. A file whose
original is **not** delivered appears on every agent-readable surface — `manifest.json`,
`.yuhi/background-status.json`, `.yuhi/session.json`, `.yuhi/yuhi-mode-summary.json`,
`AGENT_HANDOFF.md`, `document-index.md` — only as a stable `documentId` plus a kind-only
label (`doc-<hex>.pdf`). Published companions and generated summary artifacts are named by
identity rather than from the source basename.

Identity, not the name, crosses the boundary, so counts, dedup, and Context Revisions stay
exact. **Exclusions are still reported in full — the boundary removes names, not counts.**

See T15 and "The metadata boundary" in [`docs/THREAT_MODEL.md`](THREAT_MODEL.md).

### Other fixes

- Filename identifier detection widened: a long pure-digit token that is not a calendar-valid
  date is treated as a direct identifier (`9999990001` is a student number; `20260715` stays a
  date and is preserved as useful context).
- Closed a no-op in the `REDACT` path.
- Stopped delivery of an original carrying a **known** sensitive finding.
- Stopped encrypted archives passing through uninspected.

## Verification

The metadata boundary is verified by an adversarial byte scan: every agent-visible file — each
metadata surface, the whole delivered tree, and the tree's own filenames — is scanned across
Balanced / Strict / Maximum Privacy, with and without document inspection. Raw identifier
count is 0. The regression suite is
[`packages/core/src/metadata-boundary-e2e.test.ts`](../packages/core/src/metadata-boundary-e2e.test.ts).

```
985 / 985 tests · typecheck 0 errors · lint 0 errors
CI green on Linux / macOS / Windows × Node 20, 22 · gitleaks · CodeQL
```

## Install

CLI:

```bash
npm install -g @yuhi-ai-labs/yuhi@0.3.6
# or
npx @yuhi-ai-labs/yuhi@0.3.6 --help
```

VS Code extension: install the attached `yuhi-vscode-0.3.6.vsix`.

```
sha256  cec6959b9eb3008afc35892eb8c1a42a348d470408b0d6be81a2d095344557dc
size    2,279,342 bytes (10 files)
```

## Honest limitations

Yuhi is defense-in-depth, not a sandbox. It does not claim to be completely safe, and it does
not confine the agent at the OS level.

- Yuhi controls what enters the initial context. It cannot prevent an agent or runtime the
  user permits from reaching paths outside the Prepared Workspace.
- Filename de-identification is token-based, not semantic. A personal name embedded in a
  delivered filename (`田中太郎-report.pdf`) is not detected by token rules.
- In Balanced mode, a document with no known sensitive finding is delivered as the original
  **with an explicit inspection-pending warning** — by design, so one unsupported parser
  cannot empty your workspace. Choose Maximum Privacy to keep such originals local.
- "Estimated context reduction" is an estimate of repository representation, not measured
  provider token usage or billing savings.
- Node.js does not expose descriptor-relative `openat(2)`. Yuhi repeats `O_NOFOLLOW`,
  canonical containment, symlink, and hash checks at every critical boundary and fails
  closed, but does not claim an OS-level filesystem sandbox.

Full history: [`docs/CHANGELOG.md`](CHANGELOG.md).
