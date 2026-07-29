# Yuhi — Architecture

Status: Draft (v0.1). Core must never depend on VS Code.

## Monorepo layout

```
yuhi/
├── apps/
│   ├── cli/          yuhi   — commander-based CLI, i18n, rendering
│   └── vscode/       (Phase 3)   — VS Code extension; calls Core, never reimplements it
├── packages/
│   ├── shared/       @yuhi/shared   — types, constants, Result/error helpers (no I/O)
│   ├── config/       @yuhi/config   — load/validate yuhi.yaml, defaults, JSON schema
│   ├── policy/       @yuhi/policy   — glob matching, rule precedence, action resolution
│   ├── scanner/      @yuhi/scanner  — file walk, ignores, deterministic detectors, entropy
│   ├── workspace/    @yuhi/workspace— secure copy generator, redaction, manifest+hashes
│   ├── agents/       @yuhi/agents   — AgentAdapter interface + dummy/claude/codex/gemini
│   ├── audit/        @yuhi/audit    — local metadata-only audit log
│   └── core/         @yuhi/core     — orchestration (init/scan/preview/run), UI-agnostic
├── schemas/yuhi.schema.json
├── locales/          en, ja, zh-CN message catalogs
└── examples/ docs/ tests/
```

Dependency direction (no cycles):

```
shared ← config, policy, scanner, workspace, agents, audit
config,policy,scanner,workspace,agents,audit ← core
core ← apps/cli, apps/vscode
```

## Package responsibilities

- **shared** — Pure types (`Action`, `Rule`, `Policy`, `ScanFinding`, `FileDecision`,
  `PreviewResult`, `WorkspaceManifest`, `AuditRecord`) and small helpers. No fs/net.
- **config** — Parse YAML → validate with a schema (Zod) → normalized `Policy`.
  Emits `schemas/yuhi.schema.json` (generated) for editor validation.
- **policy** — Given a `Policy` and a list of files (+ scan findings), resolve one
  `FileDecision` per file with the winning rule and human-readable reason.
- **scanner** — Enumerate files honoring `.gitignore`/`.dockerignore`/`.npmignore`/
  `.ignore`, detect secrets via pluggable detectors (regex + entropy), and flag
  binary/large/symlink/untracked files. Detectors are a registry; results never
  include raw secret values (only ranges + masked previews).
- **workspace** — Materialize a filtered copy under `~/.yuhi/workspaces/<id>`.
  Applies block/redact/local-only, guards against symlink escape & path traversal,
  writes a `manifest.json` with source+output hashes, sets restrictive permissions.
- **agents** — `AgentAdapter` interface; `detect()`, `buildCommand()`, `validate()`.
  Adapters return an argv array (never a shell string). Bundled `dummy` adapter for
  offline demos/CI.
- **audit** — Append metadata-only JSON records under `~/.yuhi/audit/`.
- **core** — Ties it together: `runInit`, `runScan`, `runPreview`, `runWorkspace`,
  `runAgent`. Accepts injected reporters so CLI and VS Code can render differently.

## Agent adapter interface

```ts
export interface AgentAdapter {
  id: string;                 // "claude" | "codex" | ...
  displayName: string;
  detect(): Promise<boolean>; // is the agent CLI installed?
  installHint(): string;      // shown when not installed
  validate(ctx: AgentRunContext): Promise<ValidationResult>;
  buildCommand(ctx: AgentRunContext): Promise<AgentCommand>; // { file, args[], cwd, env }
}
```

Commands are executed with `spawn(file, args, { cwd, env })` — **never** `shell:true`
and never string concatenation. The child env is built explicitly (see THREAT_MODEL).

## Data flow: `yuhi run claude`

```
load config ─► scan repo ─► policy resolve ─► preview (render) ─►
workspace create (copy+redact, manifest) ─► adapter.buildCommand ─►
spawn agent (cwd=workspace) ─► inherit exit code ─► audit write ─► cleanup(prompt)
```

## Tooling

- Language: TypeScript (strict). Runtime target Node 20+.
- Package manager: pnpm workspaces.
- Dev run: `tsx` (packages expose `src/index.ts`); Tests: `vitest`.
- Build: `tsup` per package → `dist/` (ESM + types).
- Lint/format: ESLint + Prettier. Typecheck: `tsc --noEmit` per package.

See ADR-0002 for why tsx/vitest/tsup over TS project references.

## Extensibility (post-MVP, designed-for-not-built)

- **Local processing pipeline**: `local-only`/`summarize-local`/`metadata-only` feed a
  future local-model stage (Ollama, llama.cpp, vLLM, LM Studio, local VLM/embeddings)
  whose *output* (a sanitized summary) may then be allowed to an external agent.
  LLM classification is only ever an *additional* signal, never the security boundary.
- **Sandbox backends**: pluggable `RunBackend` (process | docker | sandbox-exec |
  bubblewrap/namespaces | Windows Sandbox). MVP ships `process` only.
