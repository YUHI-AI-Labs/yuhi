# Yuhi v0.3.6 cross-Mac handoff

This is the operational handoff for moving Yuhi development to another Mac. It intentionally
contains no credentials, environment values, personal paths, private data, or raw findings.

## 1. Product in one sentence

Yuhi is an agent-neutral repository preparation and evidence layer: prepare once, run with
Claude Code or Codex, measure the prepared context, review agent changes, and explicitly
apply only revalidated changes.

## 2. Release history and stable contracts

- **v0.3.3 — Context Compression:** deterministic TS/JS structure compression, honest
  accessible-content estimates, and fast foreground preparation.
- **v0.3.4 — Multi-agent reuse:** immutable Context ID, Claude/Codex adapters, and one
  Prepared Repository reused without re-preparation.
- **v0.3.5 — Progressive Context:** background PDF/DOCX/OCR/local-summary processing,
  deterministic Context Revision, safety-gated atomic publish, public/private queue boundary,
  Cancel and Refresh.
- **v0.3.6 — Safe Patch Review:** private pre-agent snapshots, deterministic Patch and
  Prepared Working Tree IDs, masked review, file/hunk selection, Trusted Apply, private
  backup, atomic rollback, transactional Undo, Discard, and CLI/VS Code parity.

Never weaken these contracts:

1. Source and Prepared repositories are different trust zones.
2. No Source write occurs without explicit user confirmation.
3. `applyPatchSession()` is the only public forward-Apply boundary.
4. Caller risk, eligibility, hashes, paths, and content are untrusted.
5. Core reloads private state and revalidates current Prepared and Source bytes.
6. Compressed/background/binary/mode/internal/credential/PII/conflicting changes cannot
   overwrite Source in v0.3.6.
7. Public output contains relative paths and metadata only; sensitive diff spans are masked.
8. Private state stays outside every agent-visible root.
9. Yuhi prepares initial context but does not claim OS-level agent confinement.
10. Background processing never blocks Yuhi Mode readiness.

## 3. Current release-candidate state

- Working branch at RC construction: `feature/per-format-and-cleanup`.
- Pre-v0.3.6 local HEAD: `08e7c956d5ec12c4acb2cfcf9abff1a31fdba0a7`.
- The v0.3.6 implementation and release docs are currently uncommitted.
- Package versions: CLI and VS Code `0.3.6`.
- Full automated gate: 93 test files, 950 tests, zero failures.
- Typecheck, lint (zero errors), Core/Agents/CLI/VS Code builds, and diff check pass.
- Synthetic filesystem acceptance covers normal Apply/Undo, Source conflict, compressed
  blocking, secret blocking/masking, two-file rollback, and Claude/Codex session separation.
- The VSIX was installed successfully into an isolated VS Code user-data/extensions pair.
- Real GUI E2E, upgrade testing, commit/push, CI, Marketplace publication, npm publication,
  Git tag, and GitHub Release remain pending.

Before transfer, replace this section with the final commit SHA, tag, CI URL/status,
Marketplace status, npm status, and published artifact hash if release completion occurs.

## 4. Release artifact

Repository-relative artifact:

```text
apps/vscode/yuhi.vsix
```

Inspected RC properties:

```text
Version:       0.3.6
Publisher:     yuhi-ai-labs
Publication:   not published (publication channel still pending)
Size:          2,263,687 bytes
File count:    10
SHA-256:       fca2eb5225803d4584a8b265bac59c95403ad5a6c2cddd8d8f37bc50a45da801
```

The archive contains only manifest/content metadata, package/readme/license/changelog,
two runtime bundles, and two Yuhi media assets. The inspection found no `.env`, `yuhi.yaml`,
source, tests, fixtures, source maps, node_modules, credentials, personal paths, or personal
account identity. Apparent GitHub-token-pattern matches were detector regular-expression
literals in the bundle, not credential values.

Recompute on the destination Mac; do not trust a copied checksum without checking it:

```bash
shasum -a 256 apps/vscode/yuhi.vsix
node apps/vscode/scripts/inspect-vsix.mjs apps/vscode/yuhi.vsix
```

## 5. New Mac bootstrap

Prerequisites: Git, Node.js 20+, Corepack/pnpm, VS Code, and optional Ollama/Claude Code/Codex.
Use only the organization repository and a YUHI-AI-Labs-authorized account.

```bash
git clone https://github.com/YUHI-AI-Labs/yuhi.git
cd yuhi
corepack enable
pnpm install --frozen-lockfile
git config --local user.name "YUHI-AI-Labs"
git config --local user.email "ndrg7bmfjw@privaterelay.appleid.com"
```

Do not copy `.env`, `.yuhi`, VS Code profiles, credential-helper files, pseudonym mappings,
private patch backups, queue state, real fixtures, or user data to the new Mac. Transfer
credentials through the appropriate secret-management channel, never through Git or this
handoff.

## 6. Validation commands

```bash
pnpm -r typecheck
pnpm lint
npx vitest run
pnpm --filter @yuhi/core build
pnpm --filter @yuhi/agents build
pnpm --filter @yuhi-ai-labs/yuhi build
pnpm --dir apps/vscode build
git diff --check
```

Package only after all pass:

```bash
cd apps/vscode
pnpm exec vsce package --pre-release --no-dependencies -o yuhi-vscode-0.3.6.vsix
node scripts/inspect-vsix.mjs yuhi-vscode-0.3.6.vsix
```

Install into an isolated profile before touching the normal profile:

```bash
code --user-data-dir <temporary-user-data> \
  --extensions-dir <temporary-extensions> \
  --install-extension apps/vscode/yuhi.vsix --force
code --user-data-dir <temporary-user-data> \
  --extensions-dir <temporary-extensions> \
  --list-extensions --show-versions
```

Expected: `yuhi-ai-labs.yuhi-vscode@0.3.6`.

## 7. Required real GUI checks

Use synthetic repositories only.

1. Prepare and launch Claude Code; repeat with Codex.
2. Confirm snapshot failure prevents agent launch.
3. Modify one FULL text file; review the masked baseline-to-agent diff and apply one hunk.
4. Confirm the Source changes only after the modal confirmation.
5. Undo and verify byte-for-byte Source restoration.
6. Create a synthetic secret change; confirm diff masking and disabled Apply.
7. Change Source after snapshot; confirm conflict blocking and no overwrite.
8. Modify compressed/background/binary/mode content; confirm it is non-selectable.
9. Discard Prepared changes; confirm Source and Context Revision remain unchanged.
10. Switch Claude → Codex with unreviewed changes; confirm warning, separate session
    provenance, no lost changes, and no automatic Apply.

## 8. Architecture map for v0.3.6

- `packages/core/src/patch/types.ts` — public patch/snapshot types.
- `snapshot.ts` / `diff.ts` / `provenance.ts` — baseline, changes, deterministic identities.
- `validator.ts` — representation/path/content/source policy.
- `session.ts` — private session capture, review, masked diff, hunk materialization.
- `trusted-apply.ts` — narrow public Apply boundary.
- `apply.ts` — internal atomic writer, backup, rollback, Undo, history, Discard.
- `private-state.ts` — private Source binding outside the Prepared root.
- `apps/cli/src/patch.ts` — metadata-safe CLI using the same Core APIs.
- `apps/vscode/src/agent-review.ts` / `extension.ts` — review UI and explicit actions.
- `packages/core/src/patch/acceptance.test.ts` — synthetic A–F release acceptance.

The deleted `packages/core/src/agent-changes.ts` writer must not be restored; it was the
legacy parallel Source-write route.

## 9. Known limitations

- Node.js lacks `openat(2)`-style fd-relative filesystem operations. Yuhi repeats
  `O_NOFOLLOW`, canonical containment, symlink, and hash checks and fails closed, but does
  not claim a kernel-enforced filesystem sandbox.
- No binary patch merge, mode Apply, compressed-file full replacement, AST patching,
  automatic three-way merge, automatic Git/PR operation, cloud approval, or auto-Apply.
- A launch-time Agent Session Manifest contains the snapshot identity; a later patch ID is
  reconstructed deterministically from private session state rather than written back to
  the original launch record.

## 10. Release completion order

1. Complete installed-VSIX GUI checks and CLI E2E.
2. Audit the complete intended file allowlist; exclude local fixtures and unrelated edits.
3. Build the final VSIX from the exact clean commit candidate and inspect it again.
4. Commit with the repository-local YUHI-AI-Labs identity and no Co-Authored-By.
5. Push normally; never force-push.
6. Wait for CI.
7. Publish the exact inspected Marketplace artifact as pre-release.
8. Publish the matching CLI only after its npm gate; do not reuse unrelated credentials.
9. Create the Git tag and GitHub Release with the recorded checksums.
10. Update this document with the final immutable identifiers.

## 11. What happens next

The canonical post-v0.3.6 plan is [ROADMAP.md](./ROADMAP.md). Do not begin v0.3.7 before
v0.3.6 is actually published and at least ten users have tried it. The next engineering
priority is Fast First Value and incremental preparation, not additional safety modes,
agents, patch engines, cloud services, or automatic Git operations.
