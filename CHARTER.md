# Yuhi — Project Charter

> **Yuhi prepares the right context before an AI starts. Everything else is an extension.**

This one sentence is the tie-breaker for every decision. When a proposal doesn't
serve it, the proposal is probably wrong.

## One responsibility

Yuhi does **one** thing: prepare the right context before an AI agent starts.
It is **not** an "AI Swiss-Army knife." Anything outside that responsibility belongs
in a **plugin** or an **external integration**, never in the core. Keep the core
extremely small; protect the simplicity of the product.

## The five routes (stable public vocabulary)

Every file takes exactly one route. These names are the whole product vocabulary and
are treated as **stable** — internals may change, these should not:

- **Sent to Claude** — sent unchanged
- **Prepare locally** — transformed on your machine first
- **Remove secrets** — secrets masked in the copy
- **Runtime only** — value handed to the process at run time, never read as context
- **Keep local** — never leaves your machine

(We have graduated from "Visible / Blocked / Redacted.")

## Every feature must answer one question

Before building anything, ask:

1. Does this make Yuhi easier to **understand**?
2. Does this make Yuhi easier to **adopt**?
3. Does this make Yuhi easier to **extend**?

If the answer is "no" to all three, the feature probably should not exist. Prefer
clarity over cleverness, and fewer concepts over more. Yuhi should feel obvious after
five minutes.

## Open Core

Everything an individual developer needs stays open source and genuinely useful — the
OSS project is never intentionally crippled: CLI, VS Code extension, Prepare locally,
rule-based processors, Runtime injection, Preview UI, local-model adapters, docs.

Some capabilities may later live in an Enterprise or Cloud offering (org-wide policy,
team admin, central audit, RBAC/SSO, managed processor registry, compliance,
remote policy distribution). **None of these are implemented now.** We only keep the
extension points clean enough that they *could* be added later without changing the
OSS APIs.

## Stable plugin APIs

Anything meant for extension is an **interface**, never a hardcoded implementation.
Already interfaces today: `Processor`, `RouteExecutor`, `AgentAdapter`. Planned as
interfaces before their first implementation: `LocalModelProvider`, `PolicyProvider`,
`WorkspaceBuilder`.

## Brand protection

The **code** is open; the **Yuhi brand** is not. Public APIs stay generic (avoid
baking "Yuhi" deep into them) so a fork can replace branding cleanly. Branding assets
live apart from source. See `NOTICE` for the trademark note; the code license is
Apache-2.0.

## Documentation first

Every major capability ships with an architecture note, its public API, an extension
guide, and an example implementation. Documentation is part of the product.
