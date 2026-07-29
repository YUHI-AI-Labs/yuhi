# ContextBench — a benchmark for context preparation (design sketch)

> **Status: design only.** This document defines *what* we want to measure and the
> vocabulary for it. It intentionally does **not** specify an implementation, dataset,
> or leaderboard yet. Feedback is welcome — see [`RESEARCH.md`](../RESEARCH.md) and the
> **Benchmark proposal** issue form.

## Motivation

Model benchmarks measure the model. **ContextBench measures the preparation of the
input** — the transformation a policy applies to a piece of context *before* it is
handed to an agent. The central question:

> Given some raw context and a policy, how good was the prepared context that got sent?

"Good" is a trade-off, not a single number. Removing everything is perfectly private
and useless; sending everything is maximally useful and leaks. ContextBench exists to
make that trade-off measurable and comparable.

## Unit of evaluation

A single **case** is:

| Field | Meaning |
|---|---|
| **Task** | What the agent is asked to do with the context (e.g. "summarize each student's progress"). |
| **Input** | The raw context before preparation (files, records, secrets, PII). |
| **Policy** | The `yuhi.yaml` (routes + processors) applied to the input. |
| **Output** | The prepared context actually sent to the agent (after routing/transforms). |
| **Ground truth** | The protected values that must not leak, and the task-relevant signal that should survive. |

A **suite** is a labeled collection of cases spanning domains (source code, tabular
PII, documents, mixed repos) and preparation strategies (mask, pseudonymize,
summarize-local, keep-local).

## Metrics (the four axes)

Each case is scored on four complementary axes. None dominates; a policy is
characterized by where it sits in the space.

1. **Privacy** — how much protected information was removed or transformed.
   *Higher = less protected information present in the output.*
2. **Utility** — how much task-relevant signal survived preparation.
   *Higher = the agent still has what it needs.*
3. **Leakage** — whether any specific protected value still reached the agent.
   *A hard, safety-critical measure; ideally zero. Distinct from Privacy, which is aggregate.*
4. **Task success** — whether the agent could complete the Task on the Output.
   *Measured against the task's own success criterion, not against the raw input.*

The headline view is the **privacy ↔ utility frontier**: plotting policies by privacy
and utility, with leakage as a pass/fail gate and task success as the outcome that
makes utility meaningful.

## Scoring principles (to be specified)

- **Leakage is a gate, not an average.** A single leaked protected value fails the
  case regardless of other scores.
- **Utility is task-relative.** Measured by the Task's success criterion on the
  prepared Output, not by surface similarity to the raw Input.
- **Deterministic where possible.** Prefer exact/structural checks (did token `X`
  appear?) over model-graded scores; when a judge model is used, it runs locally and
  its prompt/version is recorded.
- **Reproducible and local-first.** A case must be runnable without a cloud account;
  any model used is pinned and disclosed.
- **No real personal data.** Cases use synthetic or properly licensed fixtures.

## Explicitly out of scope (for now)

- A public leaderboard or ranking.
- Runtime/OS sandboxing quality (that is [`THREAT_MODEL.md`](../THREAT_MODEL.md), not ContextBench).
- Model capability evaluation (that is the model's benchmark, not the context's).

## Open questions

- How is "task-relevant signal" labeled without leaking it into the metric?
- How do we compare a `summarize-local` policy (lossy, semantic) against a
  `pseudonymize` policy (lossless, structural) on the same case fairly?
- What is the minimal, honest set of domains for a first release (`α`)?
- How do we score partial leakage (a pseudonym that is trivially reversible)?

## Relationship to Yuhi

Yuhi is the reference implementation of *preparation*; ContextBench is the
reference measurement of it. A policy authored in `yuhi.yaml` should be directly
runnable as a ContextBench case, so the tool and the benchmark share one vocabulary.
