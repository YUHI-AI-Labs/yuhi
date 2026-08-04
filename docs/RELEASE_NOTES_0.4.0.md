# Yuhi v0.4.0 — Dynamic Context Runtime

Claude Code now runs **through** Yuhi. A local, Anthropic-compatible gateway sits between the
agent and the provider: every new tool result is stored privately, scanned, compressed,
re-scanned and recorded before it reaches the model, and everything withheld stays
retrievable. `yuhi prepare` and its Safety Modes are unchanged.

```bash
yuhi launch claude --dynamic-context        # CLI
# VS Code: “Yuhi: Start Claude Code with Dynamic Context”
```

## What it does

- **Live-zone compression.** Claude Code re-sends its whole transcript each turn, so Yuhi
  tracks `(tool_use_id, raw hash)` → the exact bytes already delivered and re-emits them
  byte-identically. The provider's cached prefix stays valid; a restart reproduces the same
  bytes. Structural diffing proves nothing outside a `tool_result` was rewritten.
- **Compressors:** JSON outline · tolerant scan for truncated / one-line / fragment / NDJSON
  JSON · test and shell output (failures, anchors, exit code, counts preserved) · grouped
  search results · configuration (`KEY=VALUE`) · line and byte windows.
- **Reversible, bounded retrieval.** Nothing is destroyed — every omission carries a locator.
  Retrieval is authorized by the ledger (the locator must be one Yuhi exposed, or narrower),
  bounded (300 lines / 32 KB / 8,000 est. tokens), safety-rescanned, and evidenced.
  **Off by default** (see below).
- **Evidence ledger** for every delivery, retrieval and egress detection.
- **Two failure classes.** Availability failures (compressor error, timeout, nothing
  applicable) degrade to a scanned representation so the agent keeps working; security
  failures withhold, and no policy can turn that into a delivery.
- **Editor integration.** Dedicated `Yuhi · Claude Dynamic` terminal, status bar
  (`Measuring…` → `N% reduced` → `Session complete`), a Dynamic Context panel section kept
  apart from static metrics, and a session that ends when the terminal closes.

## Measured (real Claude Code, provider-reported usage)

Mixed development loop — run tests, diagnose, read source, patch, re-run — scored by
re-running the fixture's own suite. Model `claude-haiku-4-5`, n=3, retrieval off:

| | baseline | dynamic |
|---|---|---|
| patch correct | 3/3 | **3/3** |
| input-side tokens (median) | 135,825 | **105,693 (−22%)** |
| cache creation (median) | 19,554 | **7,894 (−60%)** |
| provider cost (median) | $0.01035 | **$0.00902 (−13%)** |
| delivered tool output | — | **−70%** |

Test-failure task: −15% input-side on both haiku and Sonnet, 89% tool-output reduction, cost
−20% on haiku and **parity on Sonnet**. Security across every dynamic run: 0 raw secrets in
Yuhi's surfaces, 0 metadata exposure, 0 broken anchors, 0 live-zone violations, 0 crashes.

**Results vary by task, model, cache behaviour, and retrieval configuration.** Full tables and
the raw run records: `docs/design/V0_4_0_DYNAMIC_RUNTIME.md`, `docs/design/evidence/`.

## Developer Mode — read this before upgrading

The dynamic runtime defaults to **Developer Mode**, which reverses the preparation-time
default for tool output. This is deliberate: an agent that cannot read configuration cannot
diagnose configuration.

- Claude Code **may use project configuration, including `.env`**.
- **Raw secret values are excluded from Yuhi logs, evidence, statistics, and UI** — type,
  count and a non-reversible fingerprint only.
- **Private keys, certificates, recovery keys and seed phrases are masked in every mode**,
  span-level, without withholding the rest of the file.
- **Direct re-exposure is detected and audited where possible** — a delivered value
  reappearing in a response, patch, commit body or outbound request.
- **Egress detection is a tripwire, not a complete prevention control.**
- **Strict Mode is selectable today** — `--delivery-mode strict` (CLI),
  `yuhi.dynamicContext.deliveryMode` (VS Code). Strict Mode masks detected secrets and supported identifiers before delivery. Detection coverage depends on file format and content. It is **not** a guarantee that every
  secret or identifier is removed: record-level pseudonymization covers `.csv` / `.tsv` /
  `.xlsx`, and a number with no surrounding context in a plain text file cannot be
  distinguished from any other number.

`yuhi prepare`, its Safety Modes, and Safe Patch Review / Safe Apply are unchanged.
Details: `docs/design/V0_4_0_DEVELOPER_MODE.md`, `docs/THREAT_MODEL.md`, `CLAUDE.md` conflict #4.

## Retrieval is off by default

Registering the MCP retrieval tools costs a fixed ~507 tokens in every cached prefix **and**
agent turns. Measured on the test-failure task: with the tools registered, 4 turns and **+31%
cost**; with them off, 2 turns and **−20% cost**, at identical compression. Enable per session
with `--retrieval conditional|required` (CLI) or `yuhi.dynamicContext.retrievalMode` (VS Code).

## Known limitations

1. **No real-Claude task has been run on Linux.** The full unit suite (98/98) and every
   `yuhi dynamic doctor` check pass on Linux aarch64; an end-to-end agent run there has not
   been performed. **Windows is deferred to v0.4.1.**
2. **Search/grep and large-log compression are opportunistic**, not headline features. Real
   traffic rarely delivers a large search result or log to the model — the agent greps.
   A `Read` of a log or prose file is deliberately **not** compressed: it is the agent
   scanning, and restructuring it measured +75% cost.
3. **Strict Mode's detection coverage is format-dependent.** Record-level pseudonymization
   applies to tabular files; identifiers in plain text rely on generic detection, so a bare
   number with no key context is not masked.
4. **Egress detection matches literal values.** Paraphrased, split or re-encoded secrets are
   not detected. Watched values live in gateway memory for the session.
5. **Session identity is derived from the conversation head**, because Claude Code cannot be
   made to send a Yuhi header. Two conversations that begin identically in the same
   repository share a session and its retrieval authorization.
6. **Cost benefit is model-dependent.** −20% on haiku, parity on Sonnet, same token reduction.
7. Bedrock and Vertex are **refused** rather than proxied — they do not speak the Anthropic
   Messages API at `ANTHROPIC_BASE_URL`.

## Upgrading

Nothing changes for existing `prepare` / `launch` / `patch` workflows. Dynamic context is
opt-in per launch. If you need the 0.3.x secret behaviour inside the dynamic runtime, select
Strict Mode.
