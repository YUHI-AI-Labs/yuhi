# Direction: Yuhi as the preparation gateway before AI agents

> **Status: direction, not current functionality.** Nothing in this document is
> implemented in the beta. There is no Claude/Codex launching, no automatic
> forwarding, and no Cloud service today.

## The idea

Today you run Yuhi, review the prepared context, then start your agent yourself.
The direction is to make Yuhi the easy, safe **front door** to an agent — so that
starting an agent *through* Yuhi is easier than starting it directly, and safe by
default even for non-experts.

Possible future commands (not built):

```
yuhi claude
yuhi codex
```

## Intended future flow

```
inspect workspace
→ apply local policy
→ exclude protected & irrelevant files
→ summarize large documents locally (Ollama / future providers)
→ pseudonymize sensitive information
→ show a visual review (Original / Prepared)
→ show Estimated Claude input avoided
→ require explicit human approval
→ launch the selected agent using ONLY the prepared context
```

## Design principles (carried from today)

- **Safe by default.** A non-expert should not need security knowledge; conservative
  defaults (secrets stay local, PII masked, generated/dependency dirs excluded).
- **No automatic external sending without review.** Approval is explicit; Partial/Failed
  results are never auto-forwarded.
- **Visible reasons.** Every file's state has a plain-language reason.
- **Reversible & non-destructive.** Source files are never modified.
- **Local-first**, with a possible **future managed Japan-region option** — a separate,
  clearly-optional service, not a requirement, and not part of this beta.

## Explicitly out of scope for the beta

Claude/Codex integration code, cloud backend, authentication, billing, telemetry,
automatic forwarding, provider marketplace. See [`ROADMAP.md`](../ROADMAP.md) and
[`VISION.md`](../VISION.md) for sequencing.
