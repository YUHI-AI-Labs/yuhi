# Yuhi 0.2.0 beta — release notes (draft)

- **CLI (npm):** `@yuhi-ai-labs/yuhi@0.2.0-beta.1`
- **VS Code (Marketplace):** `yuhi-vscode` `0.2.0` — publish as **pre-release** (`vsce publish --pre-release`)
- Coherent "0.2.0 beta" line. Root monorepo stays private; internal `@yuhi/*` packages are not published.

## What's available

- CLI preview: `yuhi preview` / `status` / `explain` / `diff` / `scan` / `doctor`.
- **Local context preparation** (`yuhi prepare .`): deterministic scan → local summarization
  (Ollama) → pseudonymization → deterministic safety-check → inspectable prepared workspace.
- Secret scanning + pseudonymization (names/IDs) with masking.
- Generated prepared workspace under `.yuhi/prepared/<id>/` — **source files never modified**.
- **Context Savings** led by *Estimated Claude input avoided*.
- VS Code beta (Doctor / Setup Local AI / Prepare Workspace / Review + Explorer "Prepare with Yuhi",
  Original↔Prepared diff, status states incl. inference-verified readiness) — **installable, pending
  Marketplace publication** (do not describe as "Available" until published).

## Limitations (honest)

- Token counts are **estimates** (chars/4 heuristic; a model tokenizer can be injected later).
- **Actual AI usage and billing vary** by product, provider behavior, caching, and pricing — no guaranteed savings.
- Local summarization requires **Ollama** + an installed model (`qwen3:1.7b` default; `qwen3:4b` quality option).
- Local-model quality/latency depend on hardware; older Ollama versions may fail to run newer models (update Ollama).
- **No automatic forwarding** to Claude/Codex — human review is required and recommended.
- GUI acceptance (clean-profile click-through) requires a final manual pass.

## Install

```bash
# CLI (after npm publish)
npx @yuhi-ai-labs/yuhi@latest preview
npm i -g @yuhi-ai-labs/yuhi

# Local AI
# install Ollama from https://ollama.com/download, then:
yuhi setup-local-ai      # pulls qwen3:1.7b after explicit confirmation
yuhi prepare .
```

## Artifacts + checksums

Built under `/tmp/yuhi-release-work/artifacts/` (not committed):
- `yuhi-ai-labs-yuhi-0.2.0-beta.1.tgz`
- `yuhi-vscode-0.2.0.vsix`
- `SHA256SUMS.txt`

---

## Handoff commands — DO NOT RUN without explicit approval (irreversible/remote)

```bash
# 1) Clean-profile VS Code GUI test (yours)
TMP=$(mktemp -d)
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" --install-extension apps/vscode/yuhi.vsix
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" examples/acceptance-fixture

# 2) npm publish (CLI)
cd apps/cli && npm publish --access public   # 2FA/OTP or automation token required

# 3) VS Code Marketplace (pre-release)
cd apps/vscode
npx vsce login yuhi-ai-labs                   # confirm publisher identity (permanent)
npx vsce publish --pre-release --packagePath yuhi.vsix

# 4) GitHub push + tag + release (from repo root)
git push origin main
git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1
gh release create v0.2.0-beta.1 --prerelease --title "Yuhi 0.2.0 beta" --notes-file docs/RELEASE_NOTES_0.2.0-beta.md

# 5) Post-publication verification
npx --yes @yuhi-ai-labs/yuhi@latest --version
mkdir -p /tmp/yuhi-live && cd /tmp/yuhi-live && npx --yes @yuhi-ai-labs/yuhi@latest preview
```

After publishing: rotate any npm/Marketplace tokens; update the site "VS Code" status to
**Available — Beta** and add the Marketplace install button only once the live URL exists.
