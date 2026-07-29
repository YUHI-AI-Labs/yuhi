# Yuhi — Philosophy

Read this before contributing. It is the tie-breaker for design decisions.

## Yuhi is a developer tool

Not a security product. Not an AI gateway. Not an enterprise compliance tool.

The goal is an open-source tool developers **voluntarily install because it improves
their daily workflow**. Security is a *consequence*; developer experience is the
product.

The test for any feature:

> "Would I personally install this on every project I create?"

If the honest answer is "only because it's more secure," the feature is probably
wrong. If it's "because it makes Claude Code / Codex / Gemini easier and more
pleasant to use," we're on track.

## Context is the product

Git defines repository state. Docker defines the execution environment. **Yuhi
defines AI context.**

> Give every AI agent the smallest, safest, and most **useful** context possible.

Not the largest. Not the smartest. The most useful. Everything else exists only to
improve context.

Internally, Yuhi is an **AI Context Runtime**. "Workspace" is an implementation
detail — do not describe the project as a "workspace generator." The runtime decides
what an agent can see, cannot see, what stays local, what is transformed, and what is
explained.

## `yuhi preview` is the signature

If people remember one command, it should be `yuhi preview`. Before any AI starts, a
developer can answer: *"What exactly will the AI see?"* Everything builds on preview.

- Preview over blocking.
- Explain over warning.
- Visibility over mystery.

Every hidden, redacted, or blocked file must be explainable via `yuhi explain <path>`:
which rule matched, why, what changed, and how to override it. Transparent, never
magical.

## The Git / Unix test

Commands should feel as obvious as `git status` or `docker run`:

```
yuhi preview
yuhi run claude
```

Short, memorable, composable, scriptable, discoverable. Prefer verbs. Avoid deep
command hierarchies, unnecessary configuration, and enterprise terminology. A tool
should do one thing extremely well.

## Context, not fear

Avoid fear-based messaging ("protect yourself", "prevent AI leaks", "enterprise
security"). Communicate *better AI context → better AI results → better workflow*.
Security follows naturally. And we never overclaim: Yuhi is **not** a sandbox
(see `THREAT_MODEL.md`).

## Local-first, vendor-neutral

Cloud, internet, and vendor APIs are optional. Yuhi provides value fully offline,
never requires an account, and telemetry stays opt-in forever. It supports Claude
Code, Codex, and Gemini today and should welcome Cursor, Aider, OpenHands, local
agents, and agents not yet invented — without changing the user's workflow.

## Success criterion

Yuhi succeeds when individual developers install it because *"it makes Claude Code
better"* — not because a security department requires it. Win developers first;
enterprises follow. The reverse almost never happens.
