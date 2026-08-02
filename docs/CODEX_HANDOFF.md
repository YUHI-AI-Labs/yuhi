# Yuhi — Handoff for Codex

This document hands off Yuhi development at **v0.3.5**. It is written for an AI coding agent
(Codex) picking up the work. Read it before making changes. It covers what Yuhi is, the repo
layout, the stable contracts you must not break, the security invariants, the exact current
state, and the follow-up roadmap.

> **日本語メモ:** これは Codex への引き継ぎ書です。v0.3.5 まで完成済み。`feature/per-format-and-cleanup`
> ブランチにコミット済み（v0.3.4 まで push 済み、v0.3.5 は push 保留）。VSIX は
> `apps/vscode/yuhi-vscode-0.3.5.vsix`。設計契約とセキュリティ不変条件を壊さないこと。

---

## 1. What Yuhi is

Yuhi is a **local-first context firewall and safe workspace layer for AI coding agents**. It
prepares a smaller, cleaner, safer copy of a repository *before* an agent (Claude Code / Codex)
sees it: neutralizes secrets, de-identifies tabular data, converts documents to sanitized
companions, drops noise, and optionally compresses source structure — then lets the user review
what the AI can see and launch an agent against that prepared copy.

**Governing product principle** (see `CLAUDE.md`): the success metric is getting the user into
"Yuhi Mode" (an agent running on the Prepared Repository) **fast**, while keeping safe defaults.
`file blocked ≠ launch blocked` — a single risky/unverified/excluded file must never stop the
whole workspace from launching. Heavy work happens in the background.

- Org / license: **YUHI-AI-Labs**, **Apache-2.0**. pnpm + TypeScript monorepo.
- Two shipping surfaces: the **CLI** (`@yuhi-ai-labs/yuhi`, npm) and the **VS Code extension**
  (`yuhi-ai-labs.yuhi-vscode`, Marketplace).

---

## 2. Repo layout & module map

```
packages/
  shared/      @yuhi/shared     — toPosix, hashing, docx/pptx/xlsx extractors, SafetyMode vocab
  config/      @yuhi/config     — yuhi.yaml load/validate, resolveSafetyMode (depends only on shared)
  policy/      @yuhi/policy     — allow/deny/redact rule evaluation (resolvePolicy)
  scanner/     @yuhi/scanner    — walkRepo (DEFAULT_SKIP_DIRS: node_modules/.git/dist/... ), runDetectors (secret/PII), redactText, PdfDocumentInspector
  processors/  @yuhi/processors — pseudonymize / redact pipeline primitives
  workspace/   @yuhi/workspace  — workspace materialization helpers
  audit/       @yuhi/audit      — audit log
  local/       @yuhi/local      — LocalModelProvider + OllamaProvider (timeout + AbortController)
  agents/      @yuhi/agents     — Agent Adapter interface + registry + Claude/Codex adapters + session manifest
  core/        @yuhi/core       — the preparation engine (below)
apps/
  cli/         yuhi             — CLI (tsup ESM). commands: init/scan/preview/prepare/report/launch/background
  vscode/      yuhi-vscode      — VS Code extension (esbuild CJS). Two bundles: extension.js + typescript-runtime.js
```

### `@yuhi/core` internals (the important package)
- `prepare-workspace.ts` — **the pipeline**. `prepareWorkspace` / `prepareWorkspaceOutcome`.
  Discovers files (`computePlan`), per-file loop (route → inspect → pseudonymize → safety-check →
  copy/write), writes `manifest.json` + context + handoff. Contains the **local-model reliability
  machinery** (`runLocalModelCall`, `DeadlineScheduler`, circuit breaker, budgets) and the
  **foreground→background enqueue** for deferred heavy work. **Single-writer discipline: treat this
  as the one file the "integration owner" edits.**
- `context-id.ts` — `computeContextId` → `sha256:…` deterministic base id (source hashes + Safety
  Mode + policy + compression on/off + token budget; excludes time/random/user/machine/abspath/agent).
- `context-manifest.ts` — `ContextManifest` (deterministic) + optional `progressiveContext` +
  `toPublicContextManifest` public projector.
- `prepared-run.ts` — `SafePreparedRunSummary`, `checkSafetyModeFreshness`, `readPreparedSafetyMode`.
- `document-artifact.ts` — `buildDocumentArtifact` (PDF/DOCX/PPTX → sanitized companion, or safe
  placeholder). Placeholder carries accurate size + specific reason + machine `reasonCode`.
- `compression/` — opt-in structure compression (see §6.3). `typescript-compressor.ts` lazily loads
  the TS compiler via a **host-injectable runtime** (`globalThis.__yuhiTypeScriptRuntime`), else
  `import("typescript")`. Never re-exported from the core index (kept code-split).
- `background/` — the v0.3.5 Progressive Context engine (see §6.6): `types.ts`, `state-store.ts`,
  `queue.ts`, `worker.ts`, `publisher.ts`, `revision.ts`, `status.ts`, `wiring.ts`, `index.ts`.

---

## 3. Build / test / release + conventions

```bash
pnpm install
pnpm -r typecheck                     # all 12 projects; must be clean
npx vitest run                        # full suite — 861 tests at v0.3.5 (takes >1 min)
npx vitest run <substring>            # a subset

# VS Code extension bundle + VSIX
cd apps/vscode
pnpm build                            # esbuild → dist/extension.js (lean) + dist/typescript-runtime.js (~9.5MB)
npx vsce package --no-dependencies -o yuhi-vscode-<version>.vsix
node scripts/inspect-vsix.mjs yuhi-vscode-<version>.vsix   # must be "clean" (no suspicious entries/content)
```

**Conventions (do not violate):**
- **Git identity is `YUHI-AI-Labs <…privaterelay.appleid.com>`. Do NOT add any Claude/personal
  co-author trailer** on this repo — it is a public YUHI-AI-Labs project. Never put a real name,
  personal handle, or employer email into any Yuhi artifact or commit.
- Current branch: **`feature/per-format-and-cleanup`**. **v0.3.4 is pushed** to
  `github.com/YUHI-AI-Labs/yuhi` (through `1c5f870`). **v0.3.5 is committed locally but NOT pushed**
  and NOT published (the v0.3.5 spec forbade push/publish until the maintainer decides). The repo is
  private on GitHub.
- The maintainer decides pushes/publishes. Build the VSIX; don't upload it.
- Typecheck + full vitest must be green before any release commit. Keep source-unchanged-by-prepare
  and secrets-exposed-0 invariants intact.

---

## 4. Version history (what each release delivered)

- **0.3.1** — first published 0.3.x: Repository Ready public-safe report + read-only "What the AI
  Can See" review in VS Code.
- **0.3.2** — **Safety Mode** presets (Balanced / Strict / Maximum Privacy); persisted in the
  manifest + report; VS Code selector with dirty / "Re-prepare required" launch gating.
- **0.3.3** — **Context Compression** (opt-in, TS/JS structure compression incl. **arrow block
  bodies**; expression/object/JSX arrows kept) + **faster, never-stuck preparation**
  (`deferLocalSummary` keeps Ollama off the launch path; per-file timeout + circuit breaker) +
  pre-Prepare settings UI + accurate kept-local document placeholders. The VSIX ships TypeScript as
  a **separate host-injected runtime bundle** so installed compression works.
- **0.3.4** — **One prepared repository, multiple agents.** `AgentAdapter` interface + allowlisted
  registry; **Claude + Codex** adapters (detect, `CLAUDE.md`/`AGENTS.md` gen, safe argv spawn);
  deterministic **Context ID**; Context vs Agent-Session manifest separation; `yuhi launch
  claude|codex`; VS Code **agent picker** on both the Ready and Yuhi-Mode surfaces.
- **0.3.5** — **Progressive Context.** BackgroundPreparationQueue processes PDF/DOCX/OCR/local-summary
  *after* Yuhi Mode is ready; safety-gated atomic publish; immutable base Context ID + incrementing,
  **agent-invariant** Context Revision; private/public state boundary; `yuhi background` CLI; VS Code
  background status + Cancel + Refresh.

---

## 5. Stable contracts (do not break these)

### 6.1 Preparation pipeline
`prepareWorkspaceOutcome(dir, options)` → `{ kind: "success"|"cancelled", report, launchAllowed }`.
Foreground makes **zero** heavy-processor calls (no Ollama, OCR, or heavy PDF/DOCX extraction). File
enumeration uses `walkRepo` which already skips `node_modules/.git/dist/build/coverage/.venv/…`.
Options of note: `safetyMode`, `compress` + `tokenBudget`, `deferDocumentInspection`,
`deferLocalSummary` (VS Code passes `true` → foreground summarize calls = 0), `signal`,
`onProgress`/`onProgressDetail`, injectable `deadlineScheduler`/`localModel*` knobs (for tests).

### 6.2 Safety Mode
`balanced | strict | maximum-privacy` (vocabulary lives in `@yuhi/shared`). Higher modes withhold a
strict superset; no mode ever weakens a hard block. Credentials/PII are never delivered raw in any
mode. Resolved mode is saved in the manifest; changing it marks a run dirty (VS Code gates launch).

### 6.3 Context Compression
Opt-in, deterministic, TS/JS only. Keeps imports/exports/declarations/signatures/decorators/
doc-comments; drops implementation bodies (incl. block-body arrows) → `{ /* ... */ }`. Expression/
object-literal/JSX arrows, `.d.ts`, and sub-threshold files stay FULL. **Fail-safe**: unsupported
language / parser unavailable / parse error / not-smaller → FULL with a stable reason (never partial
or silently dropped). Original source never modified. The TS compiler is **externalized** from
`extension.js` and shipped as `dist/typescript-runtime.js`, loaded lazily only when compression runs
and injected via `globalThis.__yuhiTypeScriptRuntime` (see `apps/vscode/src/typescript-runtime-entry.ts`
+ the `ensureTypeScriptRuntime` gate in `extension.ts`). **Do not statically `import "typescript"`
into the extension, and do not touch `esbuild.mjs`'s two-bundle setup without re-verifying the VSIX.**

### 6.4 Agent Adapters (`@yuhi/agents`)
`AgentAdapter { id, displayName, adapterVersion, detect(o?), prepare(ctx,o?), launch(plan,o?) }`.
`AgentRegistry` with `ALLOWLISTED_AGENT_IDS = ["claude","codex"]`, lazy factories, `get(id)` rejects
unknown ids. Adapters OWN: detection (short 2–3s timeout, never auto-install), instruction-file
generation (`CLAUDE.md`/`AGENTS.md`, merge-safe marker-delimited, no clobber), safe **argv-array**
spawn (`shell:false`) with `cwd` = the prepared repo, session metadata. Adapters must NOT do safety
scan / compression / budget / repo map / Context ID / source mutation.

### 6.5 Context ID + Context Revision
- **Context ID** (`context-id.ts`): immutable deterministic base fingerprint of the prepared run.
  Identical across agents and time. Persisted at `manifest.json.contextId` / `report.contextId`.
- **Context Revision** (`background/revision.ts`): `computeRevisionId` hashes
  `canonical(baseContextId, sorted published {relpath, sha256})` — folds in the immutable
  `baseContextId` (so it needs no per-base-file hashes) plus the safely-published artifact set.
  Deterministic; **agent-invariant** (Claude and Codex on the same run get the same `revisionId`);
  changes only when the published set changes; revision number == completed-item count (failed/
  kept-local/cancelled/timed-out do NOT bump it). `reduceProgressiveContextState` produces
  `ProgressiveContextState { baseContextId, revision, revisionId, completed/pending/failedItems,
  updatedAt }`. Canonicalization is at **v2** — bump it if you change the input set.
- **Manifests**: Context Manifest is deterministic; the per-run **Agent Session Manifest** is
  separate and records the used revision; **public projectors strip absolute paths / env / secrets.**

### 6.6 BackgroundPreparationQueue (`@yuhi/core` `background/`)
The Progressive Context engine. Public API (from `@yuhi/core`):
- `runBackgroundForRun({ runId, preparedDir, signal?, config?, providerFactory?, pdfTextExtractor?, workerConfig? })`
  → `{ completed, failed, keptLocal, pending, callsMade }` (counts only, no abspath). Opens the
  queue, runs the worker with real processors + the safety-gated publisher, rewrites the public
  status file.
- `requestBackgroundCancel({ runId, preparedDir, itemId? })` — persists a durable cancel the worker
  honors (cross-process); a result arriving after cancel is discarded, never published.
- `retryBackgroundItem(itemId)` / `retryBackgroundTerminal({ failedOnly })` — move terminal items
  back to `pending` keeping the same itemId + idempotency key; `completed` never retried.
- `publicStatusPath(preparedDir)` → `<preparedDir>/.yuhi/background-status.json`; `PublicBackgroundStatus`
  = `{ schemaVersion, counts, revision, revisionId?, items:[{relpath,kind,status,reasonCode?,preparedRelpath?}] }`.

Worker reliability: bounded concurrency (document-extraction 2, OCR 1, **local-model 1**), per-item
hard timeout, AbortSignal, global wall-time + call-count budgets, **circuit breaker** (first
summarize timeout/unavailable → zero further calls), late-result-ignored, one-failure-isolated,
terminates against a hanging provider. Publisher order is fixed: **extract/OCR/summarize →
normalize → pseudonymize/redact → secret+PII inspect → policy → temp (private staging) → atomic
rename to publish, on full success only.** Doc→OCR is a **fallback dependency** (OCR only enqueued
when extraction text is insufficient — never both up front; revision +1 per final safe artifact).

**Idempotency key** = `sha256([contextId, relpath, sourceContentHash, kind, processorVersion,
policyHash])`. State store is per-item files with atomic writes, restart recovery (crash `processing`
→ `pending`), corrupt-file → safe kept-local fallback.

---

## 6. Security invariants (non-negotiable — every change must preserve these)

1. **Raw secrets / PII are never delivered** to an agent in any Safety Mode.
2. **Original PDF/DOCX/PPTX are never shared** — only sanitized companions (or safe placeholders).
3. **The source repository is never modified** by preparation (verified by tests via SHA/`git status`).
4. **Private background state stays outside every agent-visible root.** Private records, staging
   bytes, and cancel flags live under the **managed base** at `.internal/background/<runId>/`. The
   agent (and the CLI/VS Code UI) read **only** the public `<preparedDir>/.yuhi/background-status.json`,
   which contains counts + safe relpaths + kind + reasonCode + revision — never an absolute path,
   staging/source path, provider detail, raw error, env, username, or machine name.
5. **Safe process launch**: executable + argv array, `shell:false`; never build a command from repo
   file contents; adapter ids allowlisted; working directory strictly the prepared repo.
6. **Public reports / manifests / UI never leak** absolute paths, env, raw errors, or secrets.
7. **Foreground never blocks on heavy processors** (0 Ollama/OCR/heavy-extraction on the launch path).
8. **Compression is fail-safe** → FULL; never a partial or silently-dropped file.
9. **Deferred-but-unprocessed files are kept local**, honestly labeled (`local-summary-deferred` /
   `background-*`), never delivered un-inspected, never mislabeled as "pending" unless truly enqueued.

There is a test-enforced boundary: a walk of the prepared root asserts no `.internal`/`queue.json`/
`staging`/`cancel` is present. Keep that green.

---

## 7. Current state (v0.3.5)

- Branch `feature/per-format-and-cleanup`, key commits:
  `2aea2de` background engine · `6ef1bbf` Context Revision · `fa04a1a` wiring + foreground enqueue ·
  `a373f9d` private-state boundary + doc/OCR fallback + cancel + retry · `2c53133` CLI ·
  `b7726aa` VS Code UI · `446a6bc` release (v0.3.5) · README banner fix (this handoff commit).
- **861 tests pass, `pnpm -r typecheck` clean** across all 12 projects.
- Versions: `apps/vscode` + `apps/cli` at **0.3.5**.
- VSIX: **`apps/vscode/yuhi-vscode-0.3.5.vsix`** (2.14 MB) — extension.js compiler-free, the TS
  compiler isolated in `dist/typescript-runtime.js`, `inspect-vsix` clean, clean-env compression
  verified. **Not published.** `dist/` + `*.vsix` are gitignored.
- **Not pushed** (v0.3.5). v0.3.4 is on origin.

Small notes worth your eye:
- `@yuhi/agents` was added to the **root** `package.json` devDeps so the cross-package
  `tests/integration/revision-reuse.test.ts` resolves it (like `@yuhi/core`). Fine to relocate that
  test into the `agents` package if you prefer no root dep.
- `revisionId` intentionally folds `baseContextId` rather than hashing base files individually.
- "Yuhi Mode ready before background" is proven **structurally** (report returns with items still
  `pending`, 0 heavy calls), not with an explicit temporal assertion.
- The old inline `prepareDocumentsInBackground` is superseded; documents flow through the queue.
  Python/other languages: compression returns FULL (unsupported; no parser dependency added).

---

## 8. Roadmap & explicitly out-of-scope (deferred by the maintainer)

Candidate next themes (v0.3.6+), roughly in the maintainer's stated direction:
- **Sandbox / Read-Context vs Write-Workspace separation** (this was the top deferral).
- **AST Patch Engine + Apply / Discard** of agent changes back to source.
- **MCP server** (full implementation), agent live-memory injection, auto agent-switching.
- Auto Context Refresh (v0.3.5 ships explicit **[ Refresh Context ]**; auto-refresh only if proven safe).
- More compression languages (Python etc. — would need a parser; keep the pluggable/lazy boundary).
- AICBOM v1.0 spec, telemetry, cloud sync, team management, billing.

**Do NOT** (were explicitly excluded): break the Context ID / Revision schema; add an agent CLI/SDK
as a **runtime** dependency of core (agents launch as external processes, adapters load lazily); bundle
the TypeScript compiler into `extension.js`; auto-apply agent changes to source; add remote/cloud
summarization; add Docker/VM execution.

---

## 9. Working-in-this-repo gotchas

- **`prepare-workspace.ts` is the hot, single-writer file.** When parallelizing work, keep exactly
  one agent/editor touching it per phase; everything else consumes `@yuhi/core` as a stable API.
- **Concurrent edits to a shared file clobber.** If two workstreams both edit e.g. `background/index.ts`
  or a barrel export, verify both exports survived and re-run typecheck.
- **VSIX packaging is delicate.** `esbuild.mjs` builds two outputs; `typescript` is external in the
  extension build and bundled only into `typescript-runtime.js`. After any packaging change, re-run:
  `grep -c 'function createSourceFile\|function createProgram\|transpileModule' dist/extension.js`
  must be 0, `typescript-runtime.js` must be in the VSIX, `inspect-vsix.mjs` must be clean, and a
  clean-env load of the shipped runtime must still compress.
- **Determinism**: `Date.now()` / `Math.random()` are avoided in deterministic paths (Context ID,
  revisionId, manifests). Keep them out of anything that must be byte-identical across runs/agents.
- **Reason vocabularies are stable/public** — extend, don't rename. Background: `background-pending/
  processing/completed/cancelled/timeout/provider-unavailable/extraction-failed/ocr-unavailable/
  safety-rejected/publication-failed/state-corrupt`. Local-model: `local-summary-timeout/
  local-model-unavailable/local-model-disabled/local-summary-deferred`.
- **Where to start for common tasks:** background behavior → `packages/core/src/background/`;
  agent launch → `packages/agents/src/` + `apps/*/…launch…`; the pipeline → `prepare-workspace.ts`;
  compression → `packages/core/src/compression/`; VS Code panel → `apps/vscode/src/activity-*` +
  `agent-picker.ts` + `progressive-context.ts`.

---

## 10. Definition of done (carried over from v0.3.5)

Any background/progressive change must keep: Yuhi Mode starts without waiting on heavy processors;
PDF/DOCX/OCR/summarize actually continue in the background queue; unsafe/failed results stay local;
safe results are atomically published; the queue survives restart; the Context Revision is
deterministic and agent-invariant; Claude and Codex reuse the same updated context with no
re-preparation; the UI shows honest status; cancel and retry work; **secrets exposed = 0**; source
unchanged; all tests + typecheck pass; a clean VSIX E2E passes. Only then bump version / CHANGELOG /
build the VSIX — and do not push/publish without the maintainer's go-ahead.
