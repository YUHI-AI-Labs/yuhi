# VS Code Marketplace copy — Yuhi 0.3.0

Extension displayName: **Yuhi — AI-Ready Repositories**

## (a) Short description (one line)

> Turn any repository into an AI-ready repository — prepare a smaller, cleaner,
> safer workspace locally, then share a public-safe report of exactly what the AI
> can see.

## (b) What's new in 0.3.0

- **Repository Ready card** — after a successful prepare, see concrete, measurable
  outcomes: source files, prepared artifacts, documents prepared, secrets blocked,
  identifiers transformed, and the estimated accessible-content reduction.
- **Share the result** — **Copy public report** and **Export…** as Markdown, JSON,
  or an SVG badge. Every format is public-safe: aggregate numbers only, never a
  filename, path, secret type, or identity.
- **What the AI Can See** — a read-only review of what's available vs unavailable
  to the agent, with a per-file "Claude receives" reason and an Original ↔ Prepared
  diff.
- **Documents converted, not exposed** — PDF / DOCX / PPTX become sanitized
  Markdown companions locally; the original binary is never shared.
- **Honest by design** — reduction is an estimate of agent-accessible content, not
  token or cost savings; Yuhi prepares initial context and is not an OS sandbox.

## (c) Screenshot plan

Five ordered screenshots (describe what each should show — do not generate
images). Keep every shared surface public-safe: no real filenames, paths, secret
values, or identities in captured frames; use a scratch/demo repository.

1. **Hero — the promise.** The extension entry point with the headline **"Turn any
   repository into an AI-ready repository"** and the **Prepare** button (Command
   Palette **"Yuhi: Prepare Workspace"** or the Explorer **"Prepare with Yuhi"**).
   Caption: *"One command turns any repo into AI-ready context."*

2. **Repository Ready card — the numbers.** The review panel right after a
   successful prepare, showing the Repository Ready card with Source files /
   Prepared artifacts / Documents prepared / Secrets blocked / Identifiers
   transformed and **Estimated accessible-content reduction: 94%**.
   Caption: *"Concrete, measurable outcomes — safe to share."*

3. **What the AI Can See.** The read-only review below the card: **Available to the
   AI** vs **Unavailable to the AI** with the buckets (prepared/transformed,
   included unchanged, excluded by user, excluded by policy, kept local because
   verification failed), the filter, and the Safety Mode / Context Detail labels.
   Caption: *"See exactly what the agent can — and can't — read."*

4. **Copy / Export the public report.** The **Copy public report** and **Export…**
   actions, with the format choices (Markdown / JSON / SVG badge) visible — and the
   resulting SVG "Prepared with Yuhi — 94% reduced" badge.
   Caption: *"Paste the badge or table into a README, PR, or post."*

5. **Per-file Original ↔ Prepared diff.** A single file expanded to show what
   Claude receives (transformed), the reason, and the Original ↔ Prepared diff —
   e.g. a de-identified table or a document companion.
   Caption: *"Every decision is reviewable, down to the diff."*
