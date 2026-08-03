# Yuhi — Launch kit (drafts)

Draft copy for the GitHub-stars push. **Nothing here is auto-posted.** Numbers are
either real measurements or clearly marked as illustrative. Do not invent benchmark
figures — the "how much varies" story below is the honest angle.

Canonical links
- Repo: https://github.com/YUHI-AI-Labs/yuhi
- npm: https://www.npmjs.com/package/@yuhi-ai-labs/yuhi  (`latest` = 0.3.1)
- VS Code: https://marketplace.visualstudio.com/items?itemName=yuhi-ai-labs.yuhi-vscode  (0.3.0)
- One command: `npx @yuhi-ai-labs/yuhi prepare`

---

## The honest positioning (read first)

Yuhi does **not** promise "94% smaller everywhere." Real runs:
- A clean library (express) → **0% reduction** — nothing to exclude, which is itself a
  useful signal ("your repo is already lean").
- A repo with secrets / data / build artifacts (the bundled `examples/demo`) → **97.8%**.

So the message is **"Yuhi measures how much of your repo the AI actually needs, and
prepares exactly that"** — the number is the *result*, and it honestly varies. Never
publish a fabricated fleet of "94%" numbers.

---

## Show HN

**Title:** Show HN: Yuhi – Prepare a repository before an AI coding agent reads it

**Body:**
> Coding agents (Claude Code, etc.) start inside your working tree and can read
> everything there — `.env` files, credentials, customer data, giant build artifacts.
> Most of it isn't context the task needs; some of it it shouldn't have.
>
> Yuhi runs locally before the agent: it blocks secrets, converts documents (PDF/DOCX/
> PPTX) to sanitized Markdown companions, keeps oversized/uninspectable files local, and
> prints a public-safe "Repository Ready" report of exactly what it did. Your original
> files are never modified; nothing is uploaded.
>
> One command: `npx @yuhi-ai-labs/yuhi prepare`
>
> It's Apache-2.0, local-first, no telemetry, no account. Honest about scope: it's
> defense-in-depth for AI *context*, not an OS sandbox — an agent can still reach outside
> the prepared workspace if its runtime permits. Threat model is in the repo.
>
> Would love feedback on the routing model (Available / Local-only / Blocked) and the
> report format.

---

## Reddit

**r/ClaudeAI** — Title: *I built a local tool that prepares a repo before Claude Code reads it*
> Claude Code reads your whole working tree by default. Yuhi prepares a smaller, cleaner,
> de-identified copy first (secrets blocked, documents converted, noise dropped) and hands
> you a shareable "Repository Ready" report. One command, runs on your machine, Apache-2.0.
> `npx @yuhi-ai-labs/yuhi prepare` — feedback welcome.

**r/programming** — Title: *How much of your repository should an AI coding agent actually see?*
> (Lead with the question, not the product.) Short write-up on measuring agent-accessible
> context and reducing it locally, with the honest finding that it varies a lot by repo
> (clean libraries → ~0%, repos with data/build/secrets → large reductions). Link the repo
> at the end.

**r/opensource** — Title: *Yuhi: local-first, Apache-2.0 preparation layer for AI coding agents*
> Emphasis on: no telemetry, no account, works offline, vendor-neutral, honest threat model
> (not a sandbox).

Tone: not salesy, invite critique, answer every comment.

---

## Dev.to / Zenn article

**Title (EN):** How we reduced AI-accessible repository context — and why the number varies
**Title (JA):** AIコーディングエージェントに「リポジトリのどこまで見せるか」をローカルで整える話

Outline:
1. The problem: agents read everything in the tree.
2. What Yuhi routes: Available / Local-only / Blocked; documents → sanitized companions.
3. Real numbers (honest): show a clean repo at ~0% and a messy one high; explain why.
4. The public-safe report + README badge.
5. Scope honesty: not a sandbox. Link the threat model.

---

## README badge (works today)

`yuhi report <run> --format svg` emits a real badge, e.g. `Prepared with Yuhi: 97.8% reduced`.

```bash
yuhi prepare
yuhi report <run> --format svg > .github/yuhi-badge.svg
```
```md
![Prepared with Yuhi](.github/yuhi-badge.svg)
```
Only publish a badge with a **real** number from an actual run of the repo it's on.

---

## Benchmark ("100 OSS") — do it right or not at all

Constraints found by real runs:
- `yuhi prepare` calls a local model (Ollama) per file; on a 200-file repo it took ~90s,
  and larger repos timed out past 300s. Mass-benchmarking 100 repos is slow and flaky.
- Reduction % depends entirely on repo content; many clean repos are ~0%.

If pursued: curate repos that actually carry excludable content (monorepos with build
output, data, docs, example secrets), run sequentially with generous timeouts, and publish
the **real** range — including the 0%s. The honest "it depends, here's the spread" story is
more credible than a wall of identical big numbers.
