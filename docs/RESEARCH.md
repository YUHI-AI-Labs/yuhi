# Research

Yuhi is an open-source tool, but it is also part of a longer research agenda:
**making AI trustworthy in high-trust, privacy-sensitive domains — starting with
education — using local-first, inspectable systems.**

This page introduces the pieces and how they fit together. Some are shipping code;
others are in design. We mark each honestly, and we would rather say "not yet" than
imply results we do not have.

## Why these projects belong together

Two questions decide whether an AI system is safe to use with real people's data in a
high-trust setting:

1. **What did the model receive?** — the *input* side. Raw context is where private
   data leaks before a single token is generated.
2. **How does the model behave?** — the *output* side. Even with clean input, a model
   can respond unsafely, especially for vulnerable users such as children and students.

Yuhi addresses (1). Our safety-benchmark work addresses (2). A future benchmark asks
whether the *preparation* in (1) can be measured rigorously.

---

## 1. Yuhi — context preparation (this repository)

**Status: shipping (v1.0 release candidate).**

Yuhi decides, per file, what an AI agent sees, what is prepared locally first, and
what never leaves the machine — and runs the agent on a clean copy. It is the
practical artifact of the agenda: a reproducible, open reference for *preparing*
context, with deterministic on-device transforms (pseudonymization, secret masking)
today and local-model summarization next.

See [ROADMAP.md](./ROADMAP.md).

---

## 2. Context Preparation Benchmark ("ContextBench")

**Status: in design.** A design sketch lives at [`docs/contextbench.md`](./contextbench.md).

If context preparation is a discipline, it needs a benchmark. ContextBench asks: when
a policy transforms a piece of context before it is sent to an agent, how good was
that preparation? We evaluate along complementary axes:

- **Privacy** — how much protected information was removed or transformed.
- **Utility** — how much task-relevant signal survived.
- **Leakage** — whether any protected value still reached the agent.
- **Task success** — whether the agent could still complete the task on the prepared context.

The tension between **privacy** and **utility** (removing everything is private but
useless; sending everything is useful but leaks) is the heart of the problem, and
exactly what a benchmark should quantify.

---

## 3. J-YouthSafe — model safety for youth & education (Japanese)

**Status: separate research project, in development (not yet public).**

> This is a distinct project from the Yuhi tool. The summary below is intentionally
> high-level; details will follow when it is published.

J-YouthSafe is a Japanese-language benchmark for evaluating how safely AI models
behave in youth- and education-facing contexts — the output-side counterpart to
Yuhi's input-side preparation. It reflects the view that "safe for general users" is
not the same as "safe for a child or a student," and that high-trust domains deserve
their own evaluation.

Together with Yuhi, it sketches a full picture for education: **prepare the context
safely (Yuhi), and verify the model responds safely (J-YouthSafe).**

---

## Working principles for the research

- **Local-first and reproducible.** Benchmarks and tools should run without a cloud
  account, so results can be reproduced and audited.
- **Honest limitations.** We publish what a method does *not* cover as clearly as what
  it does (see [THREAT_MODEL.md](./THREAT_MODEL.md)).
- **Open by default.** Code and evaluation artifacts are released openly where we can.

## Collaboration

We welcome collaboration — datasets, evaluation ideas, replication, or co-authored
work. Start a thread in
[Discussions](https://github.com/YUHI-AI-Labs/yuhi/discussions), or open an issue
tagged `research`.
