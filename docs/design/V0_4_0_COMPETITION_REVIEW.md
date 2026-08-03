# v0.4.0 Competition Review — required gate before implementation

Status: **complete** (this document satisfies v0.4.0 spec §4).
Date: 2026-08-03. Reviewed systems: Headroom, Aider, Continue, Serena, OpenHands.

> Numbers attributed to other projects are **their published claims**, recorded here as
> positioning data, not as measurements we reproduced. Yuhi never quotes a competitor's
> benchmark as its own, and never reports our repository-level reduction as provider token
> reduction (§17 of the spec).

---

## 0. The one finding that changes the design

**Headroom already ships the north star.** `headroom wrap claude` wraps a coding agent in one
command and compresses tool output before it reaches the model — library, proxy, and MCP server
form factors. "Start Claude Code with Yuhi" is therefore **not** a differentiator by itself.

More important, Headroom shipped a component we would otherwise have discovered the expensive
way: **CacheAligner**. Compressing content that sits inside an already-cached prompt prefix
*invalidates the provider KV cache*. A naive dynamic-compression layer can cut raw input tokens
and still **raise billed cost**, because cache-read tokens are far cheaper than cache-creation
tokens. Their answer is to compress only new bytes and keep the frozen prefix byte-identical.

Consequences for v0.4.0, adopted as hard rules:

1. **Compression must be prefix-stable.** For a given (session, object, revision) the delivered
   bytes must be deterministic and append-only where possible. Never re-compress and re-emit
   an already-delivered region with different bytes.
2. **§17's metric list is not optional.** `cache creation tokens` and `cache read tokens` must be
   measured separately, or the "20–40% lower provider input" success criterion in §18 is
   unfalsifiable — and possibly satisfied while cost goes *up*.
3. **The benchmark must include a cache-hostile condition:** a long session that re-reads the same
   files. If Dynamic Yuhi loses to Baseline there, the design is wrong, not the benchmark.

This is the single highest-risk item in v0.4.0 and it is a *cost* risk, not a correctness risk —
which is exactly the kind that ships unnoticed.

---

## 1. Where Yuhi is actually differentiated

Every reviewed system compresses or selects context. **None of them treats the repository as
untrusted and the delivered view as an audited artifact.** Yuhi's defensible position is the
intersection, not any single axis:

| Axis | Headroom | Aider | Continue | Serena | OpenHands | **Yuhi v0.4.0** |
|---|---|---|---|---|---|---|
| Wraps an existing agent transparently | ✅ | ✗ (own agent) | ✗ (own IDE ext) | partial (MCP) | ✗ (own agent) | ✅ |
| Dynamic tool-output compression | ✅ | ✗ | partial | ✗ | ✗ | ✅ |
| Semantic repo map / ranking | partial | ✅ | ✅ | ✅ | ✗ | ✅ (L0–L4) |
| Symbol-level retrieval | ✗ | ✗ | ✗ | ✅ | ✗ | ✅ |
| Conversation/history condensation | ✅ | ✗ | ✗ | ✗ | ✅ | deferred (see §5) |
| **Secret/PII gate on every delivery** | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| **Reversible private store; agent sees opaque IDs** | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| **Per-transformation evidence ledger** | ✗ | ✗ | ✗ | ✗ | partial¹ | ✅ |
| **Review-first Safe Apply with source re-hash** | ✗ | ✗ (git undo) | ✗ | ✗ | ✗ | ✅ (0.3.6, keep) |

¹ OpenHands records condensation *events* in agent history (`AgentCondensationAction`), which is
visibility into that a summary happened — not an auditable record of what was removed.

**Positioning sentence for v0.4.0:** Headroom makes context cheaper. Yuhi makes context cheaper
**and accountable** — every byte the agent sees is scanned, attributable, and reversible.

If we cannot hold the security + evidence columns, we are a worse Headroom. Compression ratio is
therefore explicitly **not** our lead metric (spec §20 already says this; this review confirms it
against the market).

---

## 2. Feature-by-feature classification

### 2.1 Headroom — closest competitor

| Feature | Verdict | Decision for Yuhi |
|---|---|---|
| Agent wrapping (`wrap claude`) | **Adopt** | This *is* §11 Yuhi Runtime. Single entry point, agent unaware. |
| Library + proxy + MCP form factors | **Improve** | Ship **MCP + in-process runtime only** for 0.4.0. A network proxy terminating provider traffic is a new trust boundary and a credential-handling surface; it contradicts local-first. Defer. |
| AST-aware code compression (signatures kept, bodies collapsed) | **Adopt** | Already shipped in 0.3.3 for the repository; v0.4.0 reuses the same compressor for *tool output* via the `Compressor` interface. |
| JSON compression (schema + stats + sample rows) | **Adopt** | This is the vertical slice 1 target (§20). |
| Log pattern clustering | **Adopt** | Slice 3. Cluster by normalized template, keep first/last + counts + all stack traces. |
| CacheAligner / prefix-stable live-zone compression | **Adopt (mandatory)** | See §0. Becomes a *contract invariant*, not a feature. |
| Image compression via trained ML router | **Reject** | A trained model breaks determinism and offline-first, and Yuhi's users hand it *sensitive* repositories. Deterministic rules only. |
| Headline "up to 95% / same answers" claims | **Reject** | Prohibited by §17. We publish measured medians with the workload named, and we publish regressions. |

### 2.2 Aider — repo map

| Feature | Verdict | Decision for Yuhi |
|---|---|---|
| tree-sitter def/ref tag extraction | **Improve** | Adopt the *idea*; use the **already-shipped TypeScript compiler runtime** (0.3.3 `typescript-runtime.js`) for TS/JS instead of adding a tree-sitter dependency and a second parser to keep self-contained in the VSIX. tree-sitter only when we add non-TS languages, and then behind the same `Compressor`/`Outliner` interface. |
| Personalized PageRank over the symbol graph | **Adopt** | §8 ranking. Personalization vector = files in the active task, edited files, git diff, mentioned identifiers. |
| Edge-weight multipliers (mentioned 10×, chat files 50×) | **Improve** | Adopt the shape, but weights must be **named constants in one table with a test that pins them**, not magic numbers spread through the ranker — they are the thing we will tune against the benchmark. |
| Binary search to fit a token budget | **Adopt** | Deterministic, cheap, and it makes "token budget" an actual guarantee. |
| Elided-code rendering with parent scope preserved | **Adopt** | Matches L1 Outline. Anchors (parent scope headers) are exactly what Safe Apply needs to stay valid. |
| Repo map recomputed per turn from scratch | **Reject** | v0.3.7's "fast first value" goal requires incremental invalidation keyed by content hash. Full recompute on every turn is the main reason repo maps feel slow. |

### 2.3 Serena — symbol-level tools over MCP

| Feature | Verdict | Decision for Yuhi |
|---|---|---|
| Symbol-level operations (`find_symbol`, `find_referencing_symbols`) instead of line/regex | **Adopt** | Directly becomes `yuhi_symbol` / `yuhi_outline` / `yuhi_retrieve` (§10). Agent-first abstraction, no line numbers in the contract. |
| LSP integration for 30+ languages | **Reject for 0.4.0** | Spawning language servers per repository is a large, stateful, non-deterministic subprocess surface, and an LSP indexes the *original* repository — bypassing the runtime boundary that is the entire point of v0.4.0. Revisit only if the language server can be pointed at the Prepared Repo. |
| Symbol-level *editing* (`insert_after_symbol`) | **Reject** | Writes must go through Safe Apply (§15), which is review-first with a source re-hash. A symbol-level write tool would become an unaudited write path. Non-negotiable. |
| Onboarding/memory files written into the repo | **Reject** | Yuhi must not write agent-authored state into the user's source tree. Private store only. |

### 2.4 Continue

| Feature | Verdict | Decision for Yuhi |
|---|---|---|
| `@`-style explicit context providers (file, docs, terminal, git diff) | **Adopt** | Expose the same affordances as MCP tools so the *user* can force context in. Explicit user intent should outrank the ranker. |
| Config-as-code for context rules | **Adopt** | Extend the existing `yuhi.yaml` — do not introduce a second config format. |
| Retrieval by embeddings / vector index | **Reject for 0.4.0** | Embedding a private repository is a data-movement question for our users, and a local index is a new secret-bearing artifact to secure and GC. Start lexical + graph (Aider shows this is enough); revisit with a local-only embedder once §16's benchmark can prove it earns its keep. |
| Being an IDE surface | **N/A** | We already have the VS Code extension; v0.4.0 adds a runtime, not a chat UI. |

### 2.5 OpenHands — condensation

| Feature | Verdict | Decision for Yuhi |
|---|---|---|
| Condenser interface with pluggable strategies | **Adopt (interface only)** | Mirrors our `Compressor` contract; keep the seam so history condensation can land later without reopening the runtime. |
| LLM-summarize old events, keep recent turns intact | **Improve → defer** | Yuhi cannot silently LLM-summarize a *conversation* it does not own, and an LLM in the delivery path is non-deterministic and can restate a secret it was shown. If adopted later: local model only, output re-scanned by the exact-output scan, and recorded in the ledger. |
| `AgentCondensationAction` — condensation is visible in history | **Adopt** | Confirms our §14 Evidence Ledger, and is *weaker* than it. Ours must record what was removed, not merely that removal occurred. |
| "50% API cost cut" claim | **Adopt as method** | The useful part is that they measured **cost**, not tokens. §17 does the same, and this is the number we should lead with when it holds. |

---

## 3. Rejected-across-the-board (deliberate non-goals)

* Any non-deterministic model in the delivery path (ML routers, LLM summarizers).
* Any network proxy that terminates provider traffic or handles provider credentials.
* Any write path that does not re-hash the source and pass Safe Apply.
* Any agent-authored state written into the user's repository.
* Any embedding index of private source in 0.4.0.
* Any headline compression claim not tied to a named workload and a measured median.

---

## 4. What this review changes in the v0.4.0 spec

Additive clarifications, recorded here and carried into `V0_4_0_ARCHITECTURE.md`:

1. **New invariant — prefix stability** (from CacheAligner). Added to §6's runtime contract and to
   the `Compressor` contract as `stableFor(objectId, revision)`.
2. **New benchmark condition** — "long session, repeated reads" is promoted from task #9 to a
   *gating* condition, and cache-creation/cache-read tokens are mandatory columns.
3. **Ranking constants are a pinned table** (from Aider) — `packages/context-ranking/src/weights.ts`
   with a test that fails when a weight changes without an update to the benchmark record.
4. **MCP tools are symbol-level, never line-level** (from Serena) — `yuhi_symbol` takes a symbol
   name and returns an object ID + outline, never a line range as its primary key.
5. **Explicit user context outranks the ranker** (from Continue).
6. **Retrieval stays lexical + graph** in 0.4.0; embeddings are explicitly deferred.
7. **Form factor is MCP + in-process runtime**; the proxy form factor is explicitly deferred.

## 5. Explicitly deferred to v0.5

* Conversation/history condensation (needs the local-model + re-scan design above).
* LSP-backed multi-language symbols (needs to index the Prepared Repo, not the source).
* Local embedding retrieval, gated on benchmark evidence.
* Proxy form factor.

---

## Sources

* [oraios/serena](https://github.com/oraios/serena) · [Serena docs (gh-aw)](https://github.github.com/gh-aw/reference/serena/)
* [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) · [headroom-ai on PyPI](https://pypi.org/project/headroom-ai/) · [Headroom as a context compression layer](https://silenceper.com/en/article/2026-06-14-headroom-ai-agent-context-compression/)
* [Building a better repository map with tree sitter (aider)](https://aider.chat/2023/10/22/repomap.html) · [Aider repository mapping system](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system)
* [OpenHands context condensation](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents) · [Condenser docs](https://docs.openhands.dev/sdk/arch/condenser) · [AgentCondensationAction PR #7311](https://github.com/OpenHands/OpenHands/pull/7311)

---

## 6. Headroom feature coverage (updated 2026-08-03, after slice 2)

Required by v0.4.0 directive §19. **No Headroom code was copied**; where a design
principle was adopted (live-zone compression, prefix/cache stability) it was re-derived
from the public description and implemented independently — see
`docs/design/V0_4_0_DYNAMIC_RUNTIME.md` §2 for our construction and the Sources list below
for what we read. Headroom is Apache-2.0 upstream; we take no code and therefore carry no
attribution obligation beyond this citation.

| Capability | Yuhi state | Where / why |
|---|---|---|
| Agent wrapper (one command) | **Done** | `yuhi launch claude --dynamic-context` wraps `performLaunch`, so Safe Apply is untouched. |
| Local proxy | **Done** | `@yuhi/context-gateway`, loopback, Anthropic Messages API compatible. Network proxy form factor still **Rejected** (credential surface). |
| Live-zone compression | **Done** | `(tool_use_id, raw hash)` → exact delivered bytes; only new blocks compressed. |
| Prefix / cache stability | **Done** | Byte-identical re-delivery, persisted across restart, structural live-zone diff with violation counter. Measured: 0 violations, cache-creation −79%. |
| Content routing | **Done** | Classified from the agent's own `tool_use` (file extension, command) before sniffing bytes. |
| JSON compression | **Done** | `json-outline`: schema, stats, samples, interesting rows, retrievable omissions. |
| Long single-line / partial JSON | **Partial** | Byte window (ADR-0005). A tolerant prefix parser is the next compressor. |
| Code compression | **Partial** | The 0.3.3 structure compressor exists for the repository but is not yet wired into the dynamic Read path. |
| Text compression | **Done** | Line window and byte window, both reversible. |
| Shell-output rewriting | **Partial** | Classified and scanned; a failures-and-anchors compressor is slice 3. |
| Log / test compression | **Planned** | Slice 3; classification and anchors specified, compressors not written. |
| HTML / XML / CSV / TSV | **Planned** | Deliberately deprioritised — absent from observed traffic (ADR-0005). |
| Reversible retrieval | **Done** — and stronger | Bounded, ledger-authorized, safety-rescanned, deterministic. Headroom exposes no equivalent authorization model. |
| MCP | **Done** | Six retrieval/explain/stats tools, all through the runtime. |
| Shared context between agents | **Rejected for 0.4.0** | Cross-agent sharing widens the authorization model; revisit with a real session token. |
| Conversation condensation | **Planned (v0.5)** | Needs a local model plus an exact-output rescan of generated text. |
| Output-token shaping | **Rejected** | Steering the model's *output* changes the answer; Yuhi's contract is to change what it *sees*. |
| Metrics / dashboard | **Done (CLI)** | `yuhi dynamic stats`, `/stats`, `yuhi_context_stats`. Cloud dashboard is out of scope (§21). |
| Timeout / fallback | **Done** | Per-compressor timeout, cancellation, and the availability/security split. |
| Session cleanup | **Done** | Gateway close flushes stats; store `gc()` is reachability-based and never drops cited evidence. |
| Multi-agent support | **Planned (v0.5)** | Codex/Gemini/Qwen need their own request contracts; only Claude is wired. |
| Image compression via ML router | **Rejected** | Non-deterministic in the delivery path (§3). |
| Headline "up to 95%" claims | **Rejected** | We publish measured medians per named workload, and publish regressions. |

### Yuhi-specific coverage (directive §20) — every dynamic path

| Guarantee | Enforced where |
|---|---|
| Secret scan before compression | `ContextRuntime.deliver` step 1; no gateway path skips it |
| PII policy | same scan (`@yuhi/scanner` detectors, one definition) |
| Metadata boundary | `scanMetadata` + `PrivateMetadata`/`PublicMetadata` scope discriminants |
| Exact-output rescan | on the precise delivered bytes, after compression, before the wire |
| Private/public state typing | `RawRef` is the only reference to original bytes |
| Known-risk withholding | security failure ⇒ `withheld`, notice carries public metadata only |
| Policy-aware retrieval | exposed-locator containment + size bounds + rescan + evidence |
| Evidence ledger | delivery, retrieval and delivered-block rows; `yuhi_explain_context` |
| Static Prepared Repository | unchanged; the gateway stores context *inside* the prepared run |
| Safe Patch Review / Safe Apply / rollback / Undo | untouched — `--dynamic-context` delegates to `performLaunch` |

A dynamic path that bypassed any row above would make v0.4.0 incomplete. The MCP tools are
the likeliest bypass and are therefore routed through `ContextRuntime`, with tests that
assert refusal for unexposed locators, foreign objects and over-large ranges.
