# ADR-0003: Policy action precedence (most-restrictive-wins)

Date: 2026-07-24 · Status: Accepted

## Context
Multiple rules (and detector results) can match one file. We need a deterministic,
safe-by-default resolution.

## Decision
Each action has a restrictiveness rank. When several signals apply to a file, the
**most restrictive** wins (fail safe). Ranks (low → high restrictiveness):

```
allow (0) < metadata-only (1) < summarize-local (2) < redact (3)
      < local-only (4) < ask (5, resolves to block when non-interactive) < block (6)
```

Additional rules:
1. A detector match (secret) escalates a file to at least `redact`, even if a path
   rule said `allow`.
2. Explicit `block` by any matching rule cannot be downgraded by another rule.
3. `ask` is a *pending* decision: interactive → user chooses; non-interactive →
   treated as `block`.
4. The winning rule's `name` and a generated reason are attached to the decision for
   `preview`/`explain`.

## Consequences
Predictable and conservative. A user who truly wants a secret-looking file exposed
must add an explicit narrower `allow` rule AND acknowledge (documented), rather than
it happening implicitly.
