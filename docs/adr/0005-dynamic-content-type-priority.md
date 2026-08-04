# ADR-0005: Dynamic content-type priority, derived from real Claude Code traffic

Status: accepted (2026-08-03)
Context: v0.4.0 slice 2 (`docs/design/V0_4_0_DYNAMIC_RUNTIME.md`), spec §6.

## Context

The v0.4.0 directive proposed this implementation order for dynamic compression:

```
JSON → shell/test output → logs → grep/search → HTML → source Read → CSV/TSV → XML → git diff
```

and required that the order be re-derived from observed traffic. We observed it: a real
`claude -p` session (Claude Code 2.0.31, haiku) investigating a 170 KB one-line JSON file,
with every request passing through the Yuhi gateway and every delivery recorded in the
evidence ledger.

## What the traffic actually looked like

First real run, 23 requests, 45 tool_result blocks, 9 of them new:

| tool | kind | blocks | est. tokens each |
|---|---|---|---|
| bash | shell-output | 5 | 4–166 |
| grep | json | 2 | **~5,000** |
| read | json | 1 | ~5,000 |
| grep | text | 1 | 57 |

Three findings, none of which we would have predicted from the library benchmark:

1. **Claude Code does not hand the model a 170 KB blob.** It self-limits tool output, so
   the "5 MB JSON in one tool_result" scenario in the spec does not occur. The real
   distribution is a long tail of tiny blocks plus a few ~20 KB ones.
2. **The large blocks are ONE LINE.** A JSON file is a single line, so a `Read`/`Grep` of
   it arrives as one 20 KB line. Our line-based text window can remove nothing from one
   line, and the JSON compressor cannot parse a *truncated* JSON fragment. Result on the
   first run: `toolResultBlocksCompressed: 0`, **0.0% dynamic reduction** — the pipeline
   was working perfectly and delivering nothing.
3. **Most blocks are re-sends.** 36 of 45 were unchanged blocks from earlier turns. The
   live-zone cache, not the compressor, is what keeps those cheap.

## Decision

1. **A byte-window path is a prerequisite, not a later content type.** `text-window` now
   windows by bytes (`B<start>-B<end>`, resolved through the store's `getRange`) when
   content has few lines but many bytes. The same applies to the availability fallback.
   After this change the identical real task measured **79–84% dynamic tool-output
   reduction**.
2. **Revised priority order**, by measured share of new tool-output tokens:

   ```
   1. long single-line text/JSON fragments   (byte window)      ← done, was blocking everything
   2. JSON (parseable)                        (json-outline)      ← done
   3. tolerant/partial JSON                   (parse the prefix of a truncated document)
   4. shell + test output                     (failures + anchors)
   5. grep/search results                     (group by file, cap per file)
   6. source Read output                      (reuse the 0.3.3 structure compressor)
   7. logs                                    (pattern clustering)
   8. HTML → CSV/TSV → XML → git diff
   ```

   Items 3 and 5 moved UP from the directive's order because grep/Read of structured
   files is where the large blocks actually came from. HTML moved DOWN: it did not appear
   in observed traffic at all, and a synthetic HTML benchmark would optimise something no
   session produced.
3. **Tiny blocks are left alone deliberately.** They still traverse the full safety
   pipeline (secret/PII/metadata scan, exact-output rescan, evidence), but the compact
   marker costs more tokens than the block contains, so `compactIsWorthIt` sends the
   scanned bytes unmarked and records a `passthrough`. Compressing them would be a
   measurable regression sold as a feature.

## Consequences

* The headline library number (70%+ on a 5 MB JSON) is NOT the number a real session
  sees. Real sessions see two effects: a ~80% cut on the few large blocks, and a
  live-zone cache that keeps 30+ re-sent blocks byte-identical. Both are reported
  separately in `yuhi dynamic stats`.
* Any future compressor must be validated against a captured real session, not only a
  synthetic fixture. `packages/context-benchmark/scripts/real-claude-run.mts` exists for
  exactly this and writes the provider-reported usage and cost alongside our estimates.
* The "large HTML ≥70%" criterion in the original spec §18 is retained as a *capability*
  target but is explicitly NOT a slice-2 gate: no observed traffic exercised it.
