# Yuhi v0.4.0 — release scope, retrieval policy, and permitted claims

Companion to `V0_4_0_DYNAMIC_RUNTIME.md` (design + evidence) and `../adr/0005-dynamic-content-type-priority.md`.
This document is the scope contract: what v0.4.0 promises, what it does not, and exactly
what may be said about it in public.

## 1. Product contract

> Yuhi dynamically compresses large Claude Code tool outputs while preserving
> task-critical evidence, edit anchors, safety boundaries, reversibility, cache
> stability, and Safe Apply.

v0.4.0 does **not** claim to reduce all Claude Code context. Measurement showed the
opposite is easy to believe and false: on a search task the compressor barely fires, and
with retrieval registered by default the token win turned into a cost loss.

**In scope (must work):** JSON and partial/one-line JSON · test and shell output · large
logs · private reversible store · retrieval opt-in · evidence ledger · cache-stable
live-zone compression · secret/PII/metadata exposure 0 · Safe Apply unchanged.

**Explicitly not release blockers:** guaranteed reduction on grep/search · HTML, CSV, XML ·
repo map · symbol retrieval · conversation condensation · non-Claude agents · full Headroom
feature parity. The Headroom coverage table stays a roadmap, not a gate — completing it was
never evidence of value, and treating it as a gate is how a release never ships.

## 2. Retrieval policy (three levels)

Reversibility is constant across all three: the original is always in the private store and
the omission is always in the ledger. What varies is what the *agent* is shown, because
that is the part that costs money.

| Mode | MCP tools | Hint | Use |
|---|---|---|---|
| **`disabled`** (default) | not registered | never | Everything that does not need omitted detail. Cheapest measured configuration. |
| `conditional` | registered | only when the compressor cannot prove it kept all load-bearing evidence (`hintPolicy: "offer-retrieval"`) | Mixed work where some outputs are lossy views. |
| `required` | registered | always, when something was withheld | Tasks whose answer is known to live in omitted content. |

`test-output-failures-and-anchors` and `search-results-grouped` declare
`hintPolicy: "answer-complete"` — they preserve every load-bearing item by contract and
`verify()` rejects a result that does not. They therefore never produce a hint, even in
`conditional`.

Measured basis for the default (haiku, test-failure task, n=3):

| | tool-output reduction | turns | provider cost |
|---|---|---|---|
| retrieval registered | 83–87% | 4 | **+31% vs baseline** |
| retrieval `disabled` | 87.9% | 2 (= baseline) | **−20% vs baseline** |

Fixed component: Yuhi's six tool definitions are **507 estimated tokens** in the cached
prefix of every request once registered (`toolDefinitionTokens()`, budget-tested at <600).
The larger component is behavioural — the agent spends turns considering retrieval.

## 3. Grep / search status

**Implemented · opportunistic · not a release headline.**

The compressor is correct in isolation (440 hits → grouped header with true counts, ≥40%
reduction, unit-tested) but fired in 1 of 3 real runs. Claude Code's `Grep` returns file
names by default, and when the agent shells out it usually aggregates with `-c`, `sort` or
`uniq` before the output would ever reach us. Search is therefore a low-value dynamic
target on this agent. The code stays; the claim does not; the release does not wait for it.

## 4. Permitted and prohibited claims

Permitted, and only with the qualifier attached:

> In measured test-output-heavy Claude Code tasks, Yuhi reduced delivered tool output by
> about 88%, provider input-side tokens by about 15%, and provider-reported cost by about
> 20%, with equal task success.
>
> Results vary by task, model, cache behaviour, and retrieval configuration.

Prohibited, without exception:

* "Yuhi always reduces Claude Code tokens by 40%."
* "Yuhi reduces costs by 80%."
* "All Claude Code traffic is compressed."
* Any presentation of **repository** reduction (a `prepare` estimate) as session, token, or
  cost reduction.
* Any single-task figure presented as a general reduction rate.

Every surface separates: static repository reduction · dynamic tool-output reduction ·
actual provider input tokens · cache creation · cache read · provider-reported cost ·
retrieval mode · retrieval count. Anything unknown prints **Not measured**, never `0`.

## 5. Release gate

| Gate | Required for v0.4.0 |
|---|---|
| Real Claude gateway | yes |
| test-output compressor | yes |
| JSON / partial-JSON | yes |
| large-log compressor | yes |
| retrieval opt-in | yes |
| Haiku validation | yes |
| Sonnet validation | yes |
| static vs dynamic comparison | yes |
| Linux real task | yes |
| task success within −2pt of baseline | yes |
| no cost regression **in the default configuration** | yes |
| live-zone violations 0 · secret/PII/metadata 0 · broken anchors 0 · gateway crashes 0 · Safe Apply regressions 0 | yes |
| grep compression · HTML · CSV · XML · repo map · symbol retrieval · conversation condensation · other agents | **no** |

Current status is tracked in `V0_4_0_DYNAMIC_RUNTIME.md`; that file is the evidence, this
one is the contract.

---

## 6. Developer Mode (added to v0.4.0 scope)

The dynamic runtime defaults to **Developer Mode**: project configuration, including `.env`,
is delivered to the agent. Full design and threat treatment in
`V0_4_0_DEVELOPER_MODE.md`; the boundary table is in `../THREAT_MODEL.md`.

What this changes for claims — the old sentence is now false and must not be used:

| Claim | Status |
|---|---|
| "Secrets are not sent to Claude." | **Prohibited.** Under Developer Mode they are, deliberately. |
| "Secret values are not written to Yuhi logs, evidence, or UI." | Permitted — and enforced by tests that byte-scan everything Yuhi wrote. |
| "Secrets exposed: 0" (report/benchmark/UI) | Permitted **only** with the redefined meaning: zero raw values in Yuhi's own surfaces. `agentVisibleSecrets` states the deliberate half separately. |
| "Private keys are never delivered." | Permitted. Key material is masked in every mode, span-level, without withholding the rest of the file. |
| "A secret leaving is blocked." | **Prohibited.** v0.4.0 detects, warns and audits; blocking is Enterprise Strict Mode. |

Strict Mode (`STRICT_MODE_POLICY`) keeps the 0.3.x behaviour whole and is selectable today;
Enterprise Strict Mode — policy-based redaction, approvals, organisation rules — is a later
release and is not a v0.4.0 gate.
