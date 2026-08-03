# Yuhi v0.4.0 — Repository Virtualization Runtime (architecture of record)

Prerequisite: `V0_4_0_COMPETITION_REVIEW.md` (spec §4 gate) — **complete**.
Governing principles: `../../CLAUDE.md`. Security claims: `../THREAT_MODEL.md`.

v0.4.0 changes what Yuhi *is*: from a repository preparation tool to the **only path between an
AI agent and a repository**. `prepare` remains, but it is now one producer of context, not the
product.

```
Repository → Yuhi Prepare → Virtual Repository → Yuhi Runtime → agent (Claude/Codex/Gemini/Qwen)
                                                      ↑
                        Read · Grep · Glob · Bash · Test · MCP · Conversation
                                                      ↓
                                    Dynamic Context → Safe Apply
```

---

## 1. Package layout

`packages/core/src/prepare-workspace.ts` is **not** extended with runtime logic (spec §5, and it is
a single-writer file per `MIGRATION_HANDOFF.md` §0.5). New packages, interface-only coupling:

| Package | Responsibility | Depends on |
|---|---|---|
| `@yuhi/context-store` | Reversible private object store. Original bytes, ranges, lines, JSONPath, search, stats, gc. | `@yuhi/shared` |
| `@yuhi/context-compression` | `Compressor` kernel + per-content-type compressors. Pure; no I/O. | `@yuhi/shared` |
| `@yuhi/context-runtime` | `ContextEvent` pipeline: safety → compression → exact-output rescan → evidence → delivery. Owns the ledger. | store, compression, `@yuhi/scanner` |
| `@yuhi/context-retrieval` | Level-aware retrieval (L0–L4) over the store; authorization + evidence on every read. | store, runtime |
| `@yuhi/context-ranking` | Repository Map ranking. Pinned weight table. | store |
| `@yuhi/context-gateway` | MCP server exposing `yuhi_*` tools; the agent-facing surface. | retrieval, runtime |
| `@yuhi/context-benchmark` | Three-condition harness + metric collection (§16/§17). | runtime, gateway |

Slice 1 (this change) lands **store, compression, runtime** plus the benchmark skeleton. Retrieval,
ranking, and gateway are scaffolded by the architecture but implemented in later slices (§9 below).

---

## 2. Runtime contract — `ContextEvent`

Every interaction becomes a `ContextEvent`. **No tool bypasses the pipeline.**

```ts
interface ContextEvent {
  id: ContextEventId;          // opaque, deterministic: sha256(sessionId, seq, tool, rawHash)
  sessionId: SessionId;
  seq: number;                 // monotonic per session; ordering is part of the ledger
  tool: ToolName;              // read | grep | glob | bash | test | search | mcp | conversation
  kind: ContentKind;           // source | html | json | xml | csv | tsv | markdown | log |
                               // test-output | shell-output | git-diff | pdf-companion | text
  rawContent: RawRef;          // NEVER a public string — an object id into the private store
  privateMetadata: PrivateMetadata;  // absolute paths, source basenames, hostnames, env — never delivered
  publicMetadata: PublicMetadata;    // counts, sizes, kinds, opaque ids — safe to deliver
  timestamp: Timestamp;        // injected clock; never `Date.now()` inline (determinism/tests)
}
```

Two rules make this contract load-bearing rather than decorative:

* **`rawContent` is a reference, not a value.** The type system prevents raw bytes from reaching a
  delivery surface: `RawRef` is a branded object id, and only the store can resolve it.
* **`privateMetadata` / `publicMetadata` are separate types with no structural overlap**, so a
  delivery function that accepts `PublicMetadata` cannot be passed the private half. This continues
  the 0.3.6 P0-C metadata boundary into the runtime.

### Pipeline (spec §13, no exceptions)

```
Raw → Secret Scan → PII Scan → Metadata Scan → Compression → Exact Output Scan → Evidence → Agent
```

* Secret/PII/metadata scanning reuses `@yuhi/scanner` (`runDetectors`, `redactText`) — v0.4.0 adds
  **no new detector implementations**, so there is one place secrets are defined.
* The **exact output scan** re-scans the *bytes about to be delivered*, after compression. This is
  the invariant that makes compression safe: a compressor that accidentally concatenates or
  re-encodes content cannot smuggle a secret past the pre-scan.
* **Failure never exposes raw content.** Any error, timeout, or cancellation yields a
  `DeliveryOutcome` of `withheld` carrying only public metadata — never a raw fallback. (This is
  the one place v0.4.0 deliberately differs from `prepare`, where the fallback is the FULL original:
  in `prepare` the original was already scanned; in the runtime it may not have been.)
* **Incompressible content is not a failure.** When every compressor honestly reports
  `no-reduction`, the runtime delivers the *scanned* original with `strategy: "original"` and
  `deliveryPath: "delivered-original"`. Inflating a view to look busy would violate §18; those
  bytes already passed the full safety pipeline, so delivering them is safe and honest.

### Invariant — prefix stability (from the competition review §0)

```ts
stableFor(objectId, revision): boolean
```

For a given `(objectId, revision)` the delivered bytes are byte-identical across calls, and growing
content (a streaming log) is delivered **append-only**: the previously delivered prefix is never
rewritten. Rationale: re-emitting a changed prefix invalidates the provider KV cache and can raise
billed cost while lowering raw token counts. Enforced by a test per compressor.

---

## 3. Compression kernel

```ts
interface Compressor {
  readonly id: string;
  supports(kind: ContentKind, sample: Sample): boolean;
  compress(input: CompressInput, ctx: CompressContext): Promise<CompressResult>;
  estimateTokens(text: string): number;
  verify(result: CompressResult): VerifyOutcome;   // self-check; failure ⇒ fall back
}
```

Rules (spec §7): deterministic · streaming · timeout · cancellable · thread-safe (no shared mutable
state; `ctx` carries everything) · reversible (every omission carries an object-id + locator to
retrieve it) · exact-output rescanned · falls back safely.

`verify()` is required, not advisory: a compressor asserts its own postconditions (anchors present,
no raw span longer than N copied verbatim, token estimate actually lower). A failed `verify()` is
treated exactly like a thrown error.

**Reversibility is what separates this from summarization.** Every compressor emits
`omissions: Omission[]`, each with `{ objectId, locator, kind, tokensOmitted }`, and the retrieve
path can materialize any of them. Nothing is *lost*; it is *not yet delivered*.

Content types (implementation order): **json** (slice 1) → source (reuse 0.3.3) → log · test-output ·
shell-output (slice 3) → html (slice 4) → csv/tsv · xml · markdown · git-diff · pdf-companion → text
(generic fallback, always last and always available).

---

## 4. Repository intelligence — L0…L4

```
L0 Repository Map → L1 Outline → L2 Symbol → L3 Body → L4 Original
```

A retrieval always names its level; escalation L(n)→L(n+1) is a separate authorized event, so the
ledger records *why* the agent needed the body. Ranking signals (spec §8): lexical relevance,
dependency graph, call graph, references, edited files, git diff, active task — with weights in a
single pinned table (`context-ranking/src/weights.ts`) because they are what the benchmark tunes.

Explicit user-provided context outranks the ranker (competition review §4.6).

---

## 5. Context store

```
.yuhi/context/
  objects/    # content-addressed; original bytes; mode 0600; never public
  sessions/   # per-session event log (append-only)
  history/    # revisions per object
  evidence/   # the ledger
```

API: `put · get · getRange · getLines · jsonPath · search · stats · gc`.

* Object ids are **opaque and derived from content** (`sha256`), so the same bytes stored twice are
  one object and ids are stable across runs — required for prefix stability and for cheap dedupe.
* An id is opaque *to the agent* but is not a capability: `get` is authorized per session, so a
  leaked id from one session cannot read another's objects.
* `gc()` is reachability-based over sessions and evidence, and never deletes an object an
  un-expired evidence record references — the ledger must stay verifiable.

---

## 6. MCP layer (`@yuhi/context-gateway`)

`yuhi_repo_map · yuhi_search · yuhi_outline · yuhi_symbol · yuhi_retrieve · yuhi_context ·
yuhi_explain · yuhi_stats`

Every retrieval passes **Safety → Authorization → Evidence → Delivery**, in that order, and the
tools are symbol-level: `yuhi_symbol` keys on a symbol name and returns an object id + outline, not
a line range (competition review §4.4). `yuhi_explain` is the user-facing half of the ledger: for
any delivered payload it answers *what was omitted, why, and how to get it*.

---

## 7. Yuhi Runtime — the one button

```
Start Claude Code with Yuhi → Yuhi Runtime → Claude Code
```

Claude thinks `Read`; Yuhi executes `Read → compression → evidence → Claude`. Same for Bash, Test,
Grep, Glob, MCP. The agent needs no knowledge of Yuhi (spec §3).

Form factor for 0.4.0: **MCP + in-process runtime**. A network proxy that terminates provider
traffic is explicitly deferred — it is a new credential surface and contradicts local-first.

---

## 8. Evidence ledger & Safe Apply

Every transformation records: original hash · compressed hash · strategy (compressor id + version) ·
preserved anchors · removed elements · retrieval count · safety findings (public-safe) · delivery
path. Every answer is explainable; `yuhi_explain` reads this.

Safe Apply (0.3.6) contracts are **unchanged**. The addition is one prohibition:

> **A compressed view is never write authority.**

Flow: compressed view → private mapping → review → **current source hash** → Safe Apply → rollback →
undo. A patch anchored to a compressed view is re-resolved against the private mapping and
revalidated against the *current* source hash before any write; a source that changed since the view
was delivered fails closed.

---

## 9. Slices (spec §20) and gates

| Slice | Content | Gate |
|---|---|---|
| **1 (this change)** | Large JSON → compression → private store → retrieve → evidence → benchmark skeleton | E2E test green; secrets/PII/metadata zero-exposure tests green; prefix stability test green |
| 2 | Runtime interception of `Read` for a real agent; `yuhi_retrieve` over MCP | Baseline vs Dynamic measured on tasks 1–4 |
| 3 | Logs, test output, shell output | ≥50% dynamic tool-output reduction (§18) |
| 4 | HTML | ≥70% delivered-token reduction on large HTML (§18) |
| 5 | Repo map + ranking (L0–L2), `yuhi_repo_map`/`yuhi_symbol` | Task success ≥ baseline −2% |
| 6 | Remaining content types; gateway hardening | Full §16 suite, 3 runs, all §18 criteria |

No slice ships on compression ratio alone. Gates are task success, security zeros, and **measured
provider cost** — not percentages (spec §20).

---

## 10. Measurement rules (spec §17 — binding)

Report separately and never conflate:

* **Repository static reduction** — what `prepare` changes. *Not* a provider measurement.
* **Dynamic tool-output reduction** — bytes/tokens we removed before delivery. Ours to claim.
* **Actual provider usage** — input tokens, **cache-creation tokens**, **cache-read tokens**, output
  tokens, billed cost when available. The only numbers allowed near the words "cost" or "savings".

> Repository reduction is never reported as actual Claude token reduction. A run whose raw input
> tokens fall while billed cost rises is a **regression** and must be published as one.

Cache-creation and cache-read are mandatory columns: without them the §18 criterion "provider input
20–40% lower" can be satisfied while the user pays more (competition review §0).
