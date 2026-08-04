# v0.4.0 Developer Mode — secret handling in the dynamic runtime

Scope: the **dynamic context runtime only**. `yuhi prepare` and its Safety Modes are
unchanged. Companion to `../THREAT_MODEL.md` (boundary), `CLAUDE.md` conflict #4 (principle),
and `V0_4_0_RELEASE_SCOPE.md` (claims).

## 1. Why the default changed

Through 0.3.x a detected credential was masked or the file was withheld, in every mode. That
invariant made Yuhi unusable for the most common real task: *"the app can't reach the API —
why?"* The answer lives in `.env`, and an agent handed `API_KEY=«REDACTED»` cannot tell a
wrong key from a missing one from a key pointing at the wrong environment.

v0.4.0 therefore ships **Developer Mode** as the default for dynamic context. The trade is
stated plainly rather than hidden: configuration reaches the agent; no raw value reaches
anything Yuhi writes or shows.

## 2. The four separated concerns

```
process environment    provider credentials passed to the child process, never recorded
repository contents    .env and config values — DELIVERED in Developer Mode
agent-visible result   the compact tool_result; key material always masked
public surfaces        logs, evidence, stats, panel, handoff, errors — NEVER a raw value
```

| | Developer Mode (default) | Strict Mode (`STRICT_MODE_POLICY`) |
|---|---|---|
| `.env` / config values → agent | delivered | masked before delivery |
| private keys, certs, recovery keys, seed phrases, browser/OS credential stores | **masked, always** | masked |
| withheld because a secret was merely *detected* | never | yes (0.3.x behaviour) |
| raw value in logs / evidence / stats / UI | never | never |
| egress of a delivered secret | detected · warned · audited | same |

## 3. What the pipeline actually does

```
raw tool result
  → detection (always; @yuhi/scanner, one definition of "secret")
  → key-material masking            ← every mode, span-level, never the whole block
  → policy decides delivery text    ← Developer: raw; Strict: redacted
  → metadata scan (paths, host)     ← unchanged in both modes
  → compression
  → exact-output rescan             ← policy-aware: key material always fails, ordinary
                                       findings fail only under Strict
  → evidence: type · count · fingerprint · policy · object id      ← never a value
  → agent
```

Two design points worth naming:

**Key material is masked, not withheld.** A `.env` that happens to contain a PEM block used
to withhold the entire tool result. Masking the span and delivering the rest applies
`file blocked ≠ launch blocked` at byte level: the developer keeps their answer, the key
never moves.

**The scanner knows nothing about modes.** `DeliveryPolicy` is a value the runtime consumes
(`redactSecretsBeforeDelivery`, `hardBlockedCategories`, `maskValuesInEvidence`). Adding
Enterprise Strict Mode later means adding a policy object, not a branch inside detection —
which is the requirement that keeps a future strict mode from being a rewrite.

## 4. Fingerprints: recording a finding without keeping it

Evidence records `secretFingerprints` — the first 16 hex of `sha256(value)`. That is enough
to say "this finding recurred", "this value left in a response", and "these two deliveries
carried the same credential", while a reader of the ledger learns nothing they did not
already have. No code path writes a value to disk outside the private object store.

## 5. Egress guard

Developer Mode's real risk is not the agent *reading* a secret; it is the value coming back
out. `EgressGuard` watches the values Yuhi delivered and reports their reappearance on:

* the model's **response** (scanned per chunk with a 256-char overlap, so a value split
  across SSE frames is still caught, and the stream is never buffered);
* the agent's **request** — the tool_use input of a `Write`, `Edit`, commit, issue body, or
  outbound MCP/web call.

A detection produces an `egress-detection` ledger row (direction, surface, fingerprints,
count), a counter in `stats`, and a warning. **It does not block**, and it does not interfere
with the local edit or command the developer intended. Blocking, redaction and approvals are
Enterprise Strict Mode.

## 6. Configuration compression

`config-keys-and-conflicts` compresses flat `KEY=VALUE` configuration while preserving
exactly what a diagnosis needs: every variable name, presence/absence, value type, URL
structure, and **duplicate or conflicting definitions** (a repeated key with a *different*
value is never dropped — it is usually the bug). It removes comments, repeated blank runs and
byte-identical duplicate lines, each with a retrievable line range. `verify()` fails the
result if any variable name was lost, so a compressed view can never make the agent report a
present variable as missing.

## 7. What Yuhi must not say

Permitted: *"Secret values are not written to Yuhi logs, evidence, or UI."*
Prohibited: *"Secrets are not sent to Claude."* — under Developer Mode they are, deliberately.

The launch banner in both surfaces says:

```
Developer Mode

Project configuration, including .env files, may be available to Claude Code.
Secret values are not written to Yuhi logs, evidence, or UI.
Use a future strict policy mode for pre-delivery masking.
```

The benchmark's `secretExposure` metric is redefined to match: it counts raw values found in
**Yuhi's own surfaces**, and `agentVisibleSecrets` records the deliberate half separately so
no reader can carry the old meaning into a new number.

## 8. Known limitations

1. **The egress guard matches literal values.** A secret the model paraphrases, splits, or
   base64-encodes is not detected. It is a tripwire for the common accident, not a control.
2. **Values live in gateway memory** for the life of a session, because matching requires
   them. They are never written; a core dump would still contain them.
3. **Detection quality bounds everything.** A credential no detector recognises is neither
   fingerprinted nor watched. Developer Mode makes this less dangerous than it was (nothing
   is being redacted, so a miss changes nothing about delivery) but it does mean egress
   coverage is best-effort.
4. **No approval flow.** v0.4.0 detects and audits only.
