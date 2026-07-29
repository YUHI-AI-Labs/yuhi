# Yuhi — Release Readiness Report

_A pre-public audit for the first public release (target: IPSJ, September)._
_Reviewer stance: extremely critical, first-time-visitor and maintainer perspective._
_Last updated: 2026-07._

## Verdict

The **codebase, docs, and website are in good shape** — coherent vocabulary, honest
scope, real working demo, clean tests. **But Yuhi is not releasable *today*** because
the advertised install path does not work yet and the code is not on GitHub. These are
logistics, not design flaws, and all are fixable in a focused push.

Legend: **P0** = blocks public launch · **P1** = fix before the conference · **P2** = nice-to-have.

---

## P0 — must fix before making the repo public

1. **Publish the CLI to npm.** _(Package prepared — name resolved to unscoped `yuhi`;
   `@yuhi` scope is owned by another user. The bundle is standalone, `workspace:*` deps
   moved to devDependencies, tarball verified installable.)_ The only remaining step is
   the actual publish so `npx @yuhi-ai-labs/yuhi preview` works from a clean machine — see the npm
   Release Readiness Report at the end of this file for the exact command.

2. **The code is not on GitHub, and the working account cannot push.** `YUHI-AI-Labs/yuhi`
   exists but is **empty**, and the authenticated CLI account has **read-only** access.
   Someone with write access must push the repository. Decide the exact public commit
   (history vs. squashed) before pushing.

3. **Website absolute URLs are placeholders.** `canonical`, `og:url`, `og:image`, and
   `twitter:image` point at `https://yuhi.vercel.app/`. If you share a link before setting
   the real domain, the social card and canonical break. Set the production domain, then
   update `site/index.html`.

4. **Labels aren't applied.** `.github/labels.yml` + `scripts/apply-labels.sh` are ready,
   but applying needs push access: `bash scripts/apply-labels.sh YUHI-AI-Labs/yuhi`.

## P1 — fix before the conference

5. **Empty localized docs.** `docs/ja/` and `docs/zh/` are empty (only `docs/en/GETTING_STARTED.md`
   exists). The READMEs advertise three languages; either add a JA getting-started (the IPSJ
   audience is Japanese — this matters) or scope the language switch to the README only.

6. **Enable Discussions + create categories.** Several links (SUPPORT, templates, CONTRIBUTING)
   point at Discussions categories that must exist, or they 404. Use the structure in
   `.github/DISCUSSIONS.md`. The **Research** category activates `DISCUSSION_TEMPLATE/research.yml`.

7. **Upload the GitHub social preview.** `site/og.png` is ready — upload it under
   **repo → Settings → Social preview** so repo links render the card (separate from the website OG).

8. **Decide the VS Code story.** The extension is Beta (VSIX only). Either (a) publish to the
   Marketplace with the wording below, or (b) document VSIX install clearly in the extension
   README. Right now there is no install path for a non-developer.

9. **Cut a real CHANGELOG 0.1.0 entry** at tag time (currently a placeholder).

10. **Deeper JA/ZH README parity.** The preview example, VS Code status, and architecture are
    fixed, but the "actions" list and a couple of feature-status rows still trail the English README.

## P2 — nice-to-have (raises the ceiling, not required)

- Animated demo GIF via `vhs docs/demo.tape` (static `docs/preview.png` ships now).
- A 60–90s screen recording for the talk and the repo header.
- README badges: CI status, npm version, license, VS Code installs.
- Screenshots of the VS Code extension inside `apps/vscode/README.md`.
- A one-command "try it" (`npx @yuhi-ai-labs/yuhi run dummy`) called out as the zero-risk first step.
- `SECURITY.md` opening line softened to match the "developer tool, not security product" framing.

---

## Suggested launch checklist (in order)

1. [ ] Reserve the `@yuhi` npm scope; confirm final package name(s).
2. [ ] `pnpm -r typecheck && npx vitest run && pnpm lint && pnpm build` (all green).
3. [ ] Push code to `YUHI-AI-Labs/yuhi` (write-access account); set description + topics.
4. [ ] `bash scripts/apply-labels.sh YUHI-AI-Labs/yuhi`.
5. [ ] Enable Discussions; create the categories in `.github/DISCUSSIONS.md`.
6. [ ] Publish `@yuhi-ai-labs/yuhi` to npm with provenance; verify `npx @yuhi-ai-labs/yuhi preview` works clean.
7. [ ] Deploy `site/` to Vercel (Root Directory = `site`); set the domain; update absolute URLs; upload `og.png` as the repo social preview.
8. [ ] Tag `v0.1.0`; write the CHANGELOG entry and a GitHub Release.
9. [ ] Seed 5–8 `good first issue`s (see below) so contributors have an on-ramp.
10. [ ] Final pass: click every README/site link; run the Quickstart on a clean machine.

### Seed "good first issue" ideas

- Add a `--version`/`yuhi doctor` note when config is missing.
- Add a secret detector (e.g. Slack token) with a test fixture.
- Add a Codex or Gemini agent adapter (config-only + adapter stub).
- Improve `yuhi explain` output for a redacted file.
- Add a `docs/ja/GETTING_STARTED.md` translation.
- Windows path-handling test for the workspace guard.

---

## Suggested announcement posts

**GitHub Release (v0.1.0)**
> **Yuhi v0.1.0 — prepare the right context before AI starts.**
> Yuhi decides, per file, what your AI agent sees, what's prepared locally first
> (pseudonymize, mask secrets), and what never leaves your machine — then runs the
> agent on a clean copy. Local-first, Apache-2.0, no telemetry.
> `npx @yuhi-ai-labs/yuhi preview` · CLI + VS Code · docs and roadmap in the repo.
> Honest by design: Yuhi is defense-in-depth, not a sandbox (see THREAT_MODEL).

**X / Twitter (thread)**
> 1/ Your AI coding agent can read everything in your repo — `.env`, customer data,
> private specs. Yuhi lets you *see and shape* that context before the agent starts. 🌆
> 2/ One command: `yuhi preview` shows every file's route — Sent · Prepared locally ·
> Runtime only · Keep local. No dashboards, no account, works offline.
> 3/ "Prepare locally" actually runs: student records → stable pseudonyms, on your
> machine, original untouched — only the safe copy is sent. [demo gif]
> 4/ Open source (Apache-2.0), local-first, vendor-neutral. CLI + VS Code today,
> local-model prep next. ⭐ github.com/YUHI-AI-Labs/yuhi

**LinkedIn**
> We're open-sourcing **Yuhi** — a local-first developer tool that prepares the right
> context before an AI agent starts. It decides, per file, what an agent sees, what is
> transformed locally first (e.g. pseudonymizing personal data), and what never leaves
> your machine — without modifying your files.
> It's part of a longer research agenda on making AI trustworthy in high-trust domains
> like education. Apache-2.0, no telemetry. Feedback, issues, and research collaboration
> are all welcome. 🌆 github.com/YUHI-AI-Labs/yuhi

_(All drafts avoid overclaiming and state the honest scope; adjust tone per channel.)_

---

## VS Code Marketplace wording (if publishing)

- **Display name:** Yuhi — Prepare AI Context
- **Short description:** See exactly what your AI agent can see. Preview, explain, and run
  Claude Code on a locally-prepared copy of your repo. Local-first. No telemetry.
- **Categories:** AI, Other · **Keywords:** ai, claude-code, context, privacy, local-first
- Include 2–3 screenshots (Explorer badges, the preview panel, the reveal-diff) and a note
  that it needs a `yuhi.yaml` (run **Yuhi: Initialize Project**).

---

## CTO Review

> _If this were my own OSS startup — brutally honest._

**Would I release it today?** No — but I'm close. The product is real and the story is
unusually clear. What stops "today" is entirely logistics: the install command 404s and
the code isn't pushed. Fix P0 (a focused day) and I'd ship.

**What would prevent 10,000 stars?**
- **Activation friction.** If the first command fails, or requires cloning a pnpm monorepo,
  most visitors bounce. The single biggest lever is a `npx @yuhi-ai-labs/yuhi preview` that *just works*.
- **"Why now / why me."** The honest "not a sandbox" framing is right, but a skeptic asks
  "so what does it actually stop?" The `student_scores.csv → Subject-B412F3` demo is the
  answer — it must be the first thing everyone sees (README, site, talk). Lead with the
  transformation, not the philosophy.
- **Proof it's alive.** ROADMAP + a few merged PRs + responsive Discussions in week one.
  An empty issue tracker reads as abandoned.
- **A single killer GIF.** Static preview is fine; the animated `csv → pseudonym → Claude`
  loop is what gets shared.

**What would impress researchers?** The framing that *context preparation is a measurable
discipline* (VISION + ContextBench) is genuinely novel and paper-shaped — privacy/utility as
a frontier is a real axis. To land it: ship a tiny reproducible ContextBench α with 1–2 tasks
and a metric, even trivially small. Researchers trust running code over a design doc.

**What would impress OSS contributors?** Clean monorepo, real tests, typed interfaces, honest
docs, and "adding a detector/adapter is a small PR." Deliver on that promise with 5–8 genuinely
approachable `good first issue`s and fast review. The processor/adapter extension points are
the hook — make writing one a 20-minute tutorial.

**What would impress enterprise users?** The honesty (THREAT_MODEL, no telemetry, local-first,
Apache-2.0) builds trust that fear-marketing destroys. But enterprises will ask for the thing
Yuhi explicitly isn't yet: enforcement/sandboxing and team policy. Keep that as a clearly-labeled
future (v2), and don't let it distort the developer-first core — win developers first; the
philosophy is right that the reverse rarely works.

**Bottom line:** Yuhi is a strong, differentiated v0.1 with a rare combination of clarity,
honesty, and a research thesis. Nail activation (npx works, killer demo first), prove it's
alive in week one, and it has a real shot at becoming the reference project for context
preparation.
