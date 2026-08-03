# v0.4.0 slice 2 — Dynamic Claude Code Runtime (design + measured evidence)

Prerequisites: `V0_4_0_COMPETITION_REVIEW.md`, `V0_4_0_ARCHITECTURE.md`, `../adr/0005-dynamic-content-type-priority.md`.
Branch: `feature/v0.4.0-dynamic-runtime`.

Slice 1 proved the pipeline in a library. Slice 2 puts it in the path of a **real Claude
Code process**: the agent talks to a loopback gateway, and every new tool result it
receives has been stored privately, scanned, compressed, rescanned and recorded.

---

## 1. Shape

```
yuhi launch claude --dynamic-context
        ↓
Yuhi (host process)          ── starts ──▶  Context Gateway (127.0.0.1:<ephemeral>)
        │                                          │
        └── performLaunch ──▶ Claude Code ──────────┘   ANTHROPIC_BASE_URL=gateway
                  │                    │
             Safe Apply           MCP: yuhi_retrieve · yuhi_get_lines · yuhi_get_json_path
             (unchanged)               yuhi_search_object · yuhi_context_stats · yuhi_explain_context
                                            ↓
                                   upstream (api.anthropic.com | enterprise gateway)
```

The gateway is Anthropic Messages API compatible: `POST /v1/messages` is transformed,
`/healthz` `/readyz` `/stats` are local operational endpoints, and **every other path is
forwarded verbatim** so nothing the agent needs disappears.

**Dynamic compression does not depend on MCP.** A session in which the agent never calls a
Yuhi tool is still fully compressed; MCP is only how it gets a withheld region *back*.

### Why a wrapper, not a second launch path

`--dynamic-context` calls the existing `performLaunch` with a custom child-process
runner. Prepared-run validation, the private pre-agent snapshot, Safe Patch Review and
Safe Apply are therefore untouched by construction — the flag adds an endpoint and an
env var, and changes nothing about how writes reach the source.

### Provider setups we refuse rather than break

| Detected | Behaviour |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` | **Refuse** with an explanation. Those providers do not speak the Anthropic Messages API at `ANTHROPIC_BASE_URL`; inserting a proxy would corrupt the user's setup. |
| existing non-loopback `ANTHROPIC_BASE_URL` | **Chain** it as the upstream (enterprise gateway preserved). |
| loopback `ANTHROPIC_BASE_URL` | Ignored, so re-launching cannot chain Yuhi onto itself. |
| API key / auth token / stored credentials | Forwarded untouched. Presence is checked; the value is never read, logged, or written to evidence. |

---

## 2. Live zone

Claude Code re-sends its whole transcript every turn, so "what is new" must be computed,
not assumed.

```
PrefixState: (tool_use_id, sha256(raw text)) → exact bytes previously delivered
```

* **Known pair** → re-emit the stored bytes verbatim. The provider's cached prefix stays
  valid; this is the CacheAligner lesson from the competition review, made mandatory.
* **Unknown pair** → full pipeline, then remember.
* **Changed content, same id** → treated as new (the hash is part of the key).
* **Persisted** as `delivered-block` ledger rows plus the compact bytes as a store object,
  so a gateway restart reproduces byte-identical output. Tested.

Only `messages[*].content[*]` blocks of type `tool_result` are rewritten. After
transforming, the gateway **structurally diffs** the request and asserts every changed
path matches `$.messages[i].content[j].content(\[k\].text)?`. A violation discards the
transform and forwards the original bytes — a live-zone bug must cost us the compression,
not the user's cache. `liveZoneViolations` is reported in `stats`.

## 3. Failure classes (spec §7)

| Class | Examples | Behaviour |
|---|---|---|
| **Availability** | compressor error, timeout, nothing applicable, output not smaller | Deliver a *scanned* representation: deterministic safe window (default) or scanned original, per `FallbackPolicy`. Recorded as `delivered-fallback` + `failureClass: availability`. The gap stays retrievable. |
| **Security** | exact-output rescan finds a credential, private metadata survives into the output | `withheld`. The agent gets a public-metadata notice and never the content. No policy can turn this into a delivery. |

Incompressible content is neither: it delivers the scanned original as
`delivered-original`, because inflating a view would violate §18.

## 4. Bounded reversible retrieval (spec §10)

Authorization is the ledger, not knowledge of an object id:

```
requested locator ⊆ some locator this session's deliveries EXPOSED       (or explicit policy escalation with a reason)
      ∧ resolved size ≤ 300 lines ∧ 32 KB ∧ 8,000 est tokens             (configurable)
      ∧ retrieved bytes pass secret/PII/metadata + exact-output rescan
      ∧ retrieval recorded in the ledger
```

Over-large requests are refused with a **deterministic narrower suggestion**, so the agent
can proceed without guessing. Locator grammars: `$.json[path]`, `L<from>-L<to>`,
`B<from>-B<to>`. Repeating a retrieval returns byte-identical bytes.

## 5. Measured evidence (real Claude Code, 2026-08-03)

Claude Code 2.0.31 · `claude -p --output-format json` · model `claude-haiku-4-5-20251001`
· task: find the one failing record in a 170 KB single-line JSON file and report its id and
error · usage and cost are **provider-reported**, taken from Claude Code's own JSON output.

| | Baseline (n=2) | Dynamic Yuhi (n=2) |
|---|---|---|
| Task success | 2/2 correct | 2/2 correct |
| Agent turns (median) | 10.5 | 8.5 |
| `input_tokens` | 70 / 52 | 36 / 60 |
| `cache_creation_input_tokens` (median) | 18,514 | **3,943 (−79%)** |
| `cache_read_input_tokens` (median) | 231,501 | **142,192 (−39%)** |
| Input-side tokens total (median) | 250,077 | **146,183 (−41.5%)** |
| Billed cost, provider-reported (median) | $0.01104 | $0.00967 (−12%) |
| Dynamic tool-output reduction (ours) | — | **79.2% / 83.9%** |
| tool_result blocks observed / compressed / reused | — | 40/2/32 and 21/2/15 |
| Retrievals | — | 0 |
| Live-zone violations | — | **0** |
| Compression latency (median / max) | — | **2.0 ms / 3.2 ms** |
| Gateway peak RSS | — | 131–142 MB |
| Gateway crashes | — | 0 |
| Secret / PII / metadata exposure | — | **0 / 0 / 0** |

### The honest reading

* **Token reduction ≫ cost reduction, and that is expected.** Most of what we removed was
  *cache-read* tokens, which are billed at a fraction of the rate. A 41.5% input-side token
  cut produced a ~12% cost move. Anyone reporting the 41.5% as a cost saving would be
  lying. This is precisely the failure mode the competition review flagged as the highest
  risk, and it is why cache columns are mandatory.
* **n=2 is below the §16 minimum of 3, and the variance is large** (Claude's exploration
  path differs per run: 7–12 turns). The cost delta is therefore **indicative, not
  established**. The direction of the cache-creation drop (−79%) is large enough to be
  meaningful; the cost figure is not.
* **No cost regression was observed** — the gate that matters most, given that the whole
  point of prefix stability is to avoid one.
* The first real run measured **0.0% reduction** with a perfectly working pipeline. That
  finding, not the library benchmark, drove the byte-window work in ADR-0005.

Reproduce:

```bash
npx tsx packages/context-benchmark/scripts/real-claude-run.mts \
  --condition dynamic-yuhi --workspace <dir> --task large-json \
  --model claude-haiku-4-5-20251001 --out dynamic-1.json
```

## 6. Known risks

1. **Session identity is derived from the conversation head** (model + system fingerprint +
   first user message), because Claude Code cannot be made to send a Yuhi header. Two
   conversations that begin identically in the same repository share a session, and
   therefore share retrieval authorization. Acceptable for a personal runtime; would need a
   real session token for a multi-user host.
2. **Request bodies are buffered** (default cap 64 MB) because request-side compression
   requires the whole body. Responses are never buffered.
3. **`input_tokens` alone is a misleading metric** under Claude Code's aggressive prompt
   caching — nearly all input arrives as cache creation or cache read. Any future report
   must use the three columns together.
4. **Truncated JSON is not yet parsed structurally** — it currently takes the byte window.
   A tolerant prefix parser is the next highest-value compressor (ADR-0005 item 3).
5. **No Windows verification** of the gateway path yet; CI covers Linux/macOS/Windows for
   the unit tests, but the real-Claude harness has only been run on macOS.

---

# Slice 3 — measured results, and the regression they exposed

Compressors added: **3A** test/shell output (failures + anchors), **3B** grep/search
(grouped, deduplicated, counts preserved), **3C** tolerant JSON (truncated / fragment /
one-line / NDJSON). Registry order is the routing policy (ADR-0005).

Real Claude Code, `claude -p --output-format json`, model `claude-haiku-4-5-20251001`,
fixed fixtures and prompts, n=3 per cell, provider usage and cost from Claude Code itself.

| task | condition | success | turns | input-side tokens (median) | provider cost (median) | dynamic tool-output reduction |
|---|---|---|---|---|---|---|
| test-failure | baseline | 3/3 | 2,2,2 | 36,174 | $0.00425 | — |
| test-failure | dynamic **+ MCP** | 3/3 | 4,4,4 | 65,600 | $0.00559 **(+31%)** | 83–87% |
| test-failure | dynamic **no MCP** | 3/3 | 2,2,2 | **30,702 (−15%)** | **$0.00342 (−20%)** | 87.9% |
| grep-exploration | baseline | 3/3 | 3,3,2 | 53,420 | $0.00348 | — |
| grep-exploration | dynamic | 2/3 | 3,2,3 | 55,681 | $0.00414 (+19%) | 0%, 38%, 0% |
| retrieval-required | baseline | 3/3 | 6,6,6 | 128,229 | $0.00771 | — |
| retrieval-required | dynamic + MCP | **3/3** | 7,11,8 | 139,929 | $0.00783 (≈parity) | 90–93% |

Security across every dynamic run: secret exposure 0 · PII exposure 0 · metadata exposure 0
· live-zone violations 0 · gateway crashes 0 · withheld-for-safety 0 · broken anchors 0
(anchor preservation is a compressor postcondition, enforced by `verify()`).

## 1. The regression, and its cause

On test-failure, dynamic Yuhi cut tool-output tokens by ~86% and still cost **31% more
than baseline**. The `--no-mcp` isolation run — same compression, same fixture, same
prompt, only the retrieval tools unregistered — cost **20% LESS** than baseline with
identical 2-turn behaviour and 3/3 success.

**Registering the MCP retrieval tools, not compression, caused the regression.** Two
mechanisms: their definitions enter the cached system prompt on every request, and their
presence induced the agent to spend two extra turns on a task where nothing was missing.

Two changes follow, both driven by this measurement:

1. **Retrieval is opt-in.** `--dynamic-context` no longer registers the MCP server;
   `--with-retrieval` does, and the launch banner says so. Compression never depended on
   MCP, so the default path is now the cheap one.
2. **`hintPolicy` on the compressor contract.** A compressor that preserves everything
   load-bearing by contract (`test-output`, `search-results`) declares `answer-complete`,
   and the gateway then omits the `yuhi_retrieve(...)` template. Compressors that withhold
   arbitrary content (`json-outline`, byte window, tolerant scan) keep `offer-retrieval`.
   The omitted ranges stay in the ledger and remain retrievable either way — what changes
   is whether the agent is *invited* to spend a turn.

## 2. Reversibility is now proven on real traffic

The retrieval-required task (the answer lives in a record the compact view omits) with
retrieval enabled: **3/3 correct**, and the ledger records **1, 4 and 1 delivered
retrievals** with **0 refused** across the three runs. The full chain ran end to end in
real Claude Code:

```
compact tool_result → agent identifies missing evidence → MCP yuhi_get_json_path /
yuhi_retrieve → exposed-locator + bounds check → safety rescan → bounded range delivered →
correct answer (2026-08-06T07:17:00Z, eu-west-1) → retrieval recorded in the ledger
```

Cost is at parity with baseline and turns rise (7–11 vs 6): retrieval buys correctness on
tasks that need it and costs round trips on tasks that do not. That is the trade the
opt-in flag now exposes to the user instead of hiding.

A measurement bug was fixed on the way: the gateway's `retrievals` counter was zero **by
construction**, because the MCP server runs in its own process. The count now comes from
the ledger (`tallyRetrievals`), which is the only witness both processes share.

## 3. Where slice 3 did NOT meet its gate

**3B search results — not met.** The compressor is correct in isolation (440 hits → header
plus grouped samples, ≥40% reduction, counts preserved, unit-tested) but fired in only 1
of 3 real runs. Claude Code's own `Grep` tool returns file *names* by default, and when the
agent shells out it often adds `-c`, `sort` or `uniq`, so a large content-mode result
rarely reaches the gateway. Task success was 2/3 vs baseline 3/3 and cost was 19% higher.
Verdict: keep the compressor, do not claim the win, and treat "make the agent's search
output large enough to be worth compressing" as the wrong goal — the honest conclusion is
that search is a *low-value* dynamic target on this agent, the opposite of the directive's
assumption.

**3A test output — met, once MCP is off.** ≥50% delivered-token reduction (86–88%
measured), anchors preserved, 3/3 success, and a real cost win.

**3C tolerant JSON — met in unit tests and in the gateway routing test; not yet isolated in
a real session,** because the tasks that exercise it (`head -c` of a big JSON) were not part
of this matrix.

## 4. Release gate status after slice 3

| Gate | Status |
|---|---|
| Real Claude Code gateway | **PASS** |
| JSON dynamic compression | **PASS** |
| test/shell dynamic compression | **PASS** (86–88%, cost −20%, MCP off) |
| log dynamic compression | **NOT MEASURED** (compressor exists; no real run) |
| grep dynamic compression | **FAIL** (fires in 1/3 real runs; low-value target) |
| Real retrieval usage | **PASS** (3/3, ledger-confirmed 1/4/1) |
| Haiku-class | **PASS** |
| Sonnet-class | **NOT RUN** |
| Baseline / Static / Dynamic comparison | **PARTIAL** — static-yuhi condition not run |
| n≥3 per condition | **PASS** for the three tasks measured |
| Task success within −2pt of baseline | **PARTIAL** — pass on test-failure and retrieval, fail on grep (2/3 vs 3/3) |
| Provider input tokens −20% median | **PARTIAL** — −15% on test-failure (MCP off); worse on grep and retrieval |
| Dynamic tool-output −40% median | **PASS** on test-failure/retrieval; fail on grep |
| No provider cost regression | **PASS only with retrieval off**; FAIL on grep |
| Prefix bytes changed outside live zone = 0 | **PASS** |
| Broken anchors = 0 | **PASS** |
| Secret / PII / metadata exposure = 0 | **PASS** |
| Safe Apply regression = 0 | **PASS** (untouched — `--dynamic-context` delegates to `performLaunch`) |
| Gateway crash = 0 | **PASS** |
| Linux or Windows verified | **NOT DONE** (unit suite is cross-platform in CI; the real-Claude harness has only run on macOS) |

**Recommendation: still not a release candidate.** The remaining blockers are now specific
and cheap to close: run the matrix on a Sonnet-class model, add the static-yuhi condition,
measure the log task, run the harness once on Linux, and either raise 3B's real-traffic
value or drop the claim. The token/cost story is only defensible with retrieval off, which
is why that is now the default.

Reproduce any row:

```bash
npx tsx packages/context-benchmark/scripts/matrix.mts \
  --tasks test-failure,grep-exploration,retrieval-required \
  --conditions baseline,dynamic-yuhi --models claude-haiku-4-5-20251001 \
  --runs 3 --out /tmp/matrix          # add --no-mcp for the retrieval-off variant
```
