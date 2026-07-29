# Yuhi — Vision

> Yuhi prepares the right context before an AI starts. Everything else is an extension.

## The problem

AI agents are moving into the place developers keep everything: the working tree.
When you launch Claude Code, Codex, or Gemini inside a repository, the agent starts
from whatever happens to be on disk — source, `.env` files, cloud credentials,
customer exports, private notes. Today the default is *all of it, raw*.

We spend enormous effort on what the model is (weights, benchmarks, alignment) and
almost none on **what we hand it to begin with**. Yet the input is the part a
developer actually controls, on their own machine, before any token is sent.

## The belief

**Context preparation is a missing, first-class discipline.**

Git gave repository *state* a vocabulary and a workflow. Docker did the same for the
execution *environment*. The context an agent begins from has neither — no standard
way to see it, shape it, or reason about it. Yuhi's bet is that this becomes as
routine as `git status`: before an agent runs, you look at exactly what it will and
won't receive, and you decide — per file — how each piece is prepared.

The unit of that decision is a **route**, and the whole vocabulary is small on
purpose: *Send directly · Remove secrets · Prepare locally · Runtime only · Keep
local*. Small enough to hold in your head; expressive enough to describe real work.

## The arc

1. **A tool developers want.** Not because it is "secure," but because it makes
   working with agents clearer and calmer. Preview over blocking; explain over
   warning; local-first, no account, no telemetry. (See [PHILOSOPHY.md](./PHILOSOPHY.md).)
2. **A shared vocabulary.** The same routes in the CLI, the editor, and the docs, so
   teams can talk about AI context precisely — and so other tools can adopt the words.
3. **Preparation that does real work.** Deterministic transforms today
   (pseudonymize, mask secrets); local-model summarization next — always on-device,
   always with the original left untouched.
4. **A way to measure it.** If context preparation is a discipline, it needs a
   benchmark: how much privacy is preserved, how much useful signal survives, whether
   anything leaked, whether the task still succeeds. That is the **Context Preparation
   Benchmark** — see [RESEARCH.md](./RESEARCH.md).
5. **An ecosystem.** Stable interfaces for processors and providers, so the community
   can extend preparation without forking the core.

## What success looks like

- A developer runs `yuhi preview` out of habit before pointing an agent at anything
  that matters — and it takes two seconds.
- "Prepare locally" is a normal answer to "can I let the agent see this?", not a
  compliance chore.
- Researchers cite context preparation as its own axis of AI-system quality, with
  Yuhi as one open, reproducible reference implementation.

## What Yuhi will not become

Not a sandbox, not an API gateway, not a secrets vault, not a telemetry funnel, not a
walled garden. It controls the *inputs* an agent starts from — honestly, and only
that. Where it cannot guarantee something, it says so ([THREAT_MODEL.md](./THREAT_MODEL.md)).

---

Building toward this, in order, in [ROADMAP.md](./ROADMAP.md). Disagreements and
better ideas are welcome in [Discussions](https://github.com/YUHI-AI-Labs/yuhi/discussions).
