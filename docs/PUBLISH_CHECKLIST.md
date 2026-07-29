# Publish Checklist

A pre-release checklist for shipping Yuhi. Work top to bottom. **The actual
publish commands are at the very bottom and are marked DO NOT RUN until a
maintainer approves** — publishing is manual, gated, and irreversible.

> Reminder of the honesty rule: release notes and marketing copy must not claim
> "completely safe / 100% secure / guaranteed no leaks". Yuhi is
> defense-in-depth, not a sandbox.

## 1. Name & namespace availability

Confirm the names are available (or already owned by the project) before the
first publish:

- [ ] **npm CLI package name** — check availability of the intended public name
      (e.g. `@yuhi-ai/cli`) with `npm view <name>`. If the `@yuhi` scope is
      unavailable, decide and document the final published scope. The internal
      workspace scope (`@yuhi/*`) and the published name can differ, but the
      `name` field in the published package must be the final public one.
- [ ] **VS Code Marketplace publisher** — a publisher ID is registered and you
      have access (Azure DevOps / vsce).
- [ ] **Open VSX namespace** — the namespace is claimed for the same extension.
- [ ] Names are consistent across README, docs, and package metadata.

## 2. Versioning

- [ ] Decide the version per [SemVer](https://semver.org/) (pre-1.0: minor may
      break; note it).
- [ ] Bump versions across the packages/apps being published (keep the CLI and
      VS Code extension versions coherent).
- [ ] The git tag matches the package version (`vX.Y.Z`).

## 3. Changelog

- [ ] Move items out of `## [Unreleased]` in `CHANGELOG.md` into a dated,
      versioned section.
- [ ] Breaking changes are clearly called out.
- [ ] Reset `## [Unreleased]` to empty.

## 4. Quality gates (must be green)

- [ ] `pnpm install --frozen-lockfile` succeeds.
- [ ] `pnpm -r typecheck` passes.
- [ ] `pnpm -r lint` passes.
- [ ] `pnpm -r test` passes — including **security regression tests**.
- [ ] `pnpm -r build` succeeds.
- [ ] CI is green on **all three OSes** (Linux, macOS, Windows) and supported
      Node versions (20, 22).
- [ ] Secret scan (gitleaks) is clean; no secrets in history.
- [ ] CodeQL has no unresolved high-severity alerts.

## 5. Package hygiene (CLI)

- [ ] `package.json` has correct `name`, `version`, `description`, `license`
      (Apache-2.0), `repository`, `bin` (`yuhi`), `files`/`exports`, `engines`
      (`node >= 20`).
- [ ] `npm pack` **dry run** looks correct — no stray files, no secrets, no
      `node_modules`, expected `dist/` present:

      ```bash
      pnpm --filter @yuhi-ai-labs/yuhi pack --dry-run
      ```

- [ ] Installing the packed tarball works in a clean directory and `yuhi --help`
      runs.

## 6. VS Code extension

- [ ] `vsce package` produces a `.vsix`.
- [ ] **Local install verified**: install the `.vsix` in a clean VS Code profile
      and confirm activation, scan, and preview surfaces work.
- [ ] `.vscodeignore` excludes source maps/tests/fixtures as intended.
- [ ] Marketplace metadata (icon, categories, README, repository link) is
      correct.

## 7. Supply-chain & provenance

- [ ] npm publish will use **`--provenance`** (requires `id-token: write` in the
      gated release workflow / trusted publishing).
- [ ] Generate an **SBOM** (CycloneDX):

      ```bash
      npx @cyclonedx/cyclonedx-npm --output-file sbom.json
      ```

- [ ] Generate **checksums** for release artifacts (tarball, VSIX):

      ```bash
      shasum -a 256 dist-artifacts/* > dist-artifacts/SHA256SUMS.txt
      ```

- [ ] **Signed releases** — *future*: sign artifacts/tags once signing keys are
      established. Not required for the first release, but note the intent.

## 8. GitHub release

- [ ] Draft a GitHub Release for the tag with changelog notes.
- [ ] Attach artifacts: CLI tarball, VSIX, `sbom.json`, `SHA256SUMS.txt`.
- [ ] Set repository **Topics**:

      `ai`, `ai-agent`, `claude-code`, `codex`, `gemini-cli`, `security`,
      `privacy`, `local-first`, `developer-tools`, `vscode-extension`,
      `agent-runtime`, `llm`, `open-source`

## 9. Post-publish verification

- [ ] `npm view <name>` shows the new version and the provenance badge.
- [ ] `npx <name>@latest --help` works from a clean machine.
- [ ] Extension is visible on the Marketplace and Open VSX and installs cleanly.
- [ ] Announce in Discussions (Show and tell / Announcements).

---

## Publish commands — DO NOT RUN until a maintainer approves

These are the exact commands used at publish time. They are **manual and gated**
and require maintainer-held credentials. Do not run them as part of routine
development or CI on ordinary commits.

```bash
# 1) Publish the CLI to npm with provenance and public access.
#    Requires an authenticated npm session / NPM_TOKEN and id-token permission.
#    DO NOT RUN until maintainer approves.
pnpm --filter @yuhi-ai-labs/yuhi publish --provenance --access public

# 2) Publish the VS Code extension to the Marketplace.
#    Requires a vsce personal access token. DO NOT RUN until maintainer approves.
vsce publish

# 3) Publish the same extension to Open VSX.
#    Requires an ovsx token. DO NOT RUN until maintainer approves.
ovsx publish
```

After a successful publish, complete the **Post-publish verification** section
above.
