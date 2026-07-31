# Yuhi — AI-Ready Repositories

**Turn any repository into an AI-ready repository.**

Yuhi prepares a smaller, cleaner, safer workspace before Claude Code or another AI coding
agent sees it — all locally, with no telemetry.

- Prepare your repository locally
- Review what the AI can see
- Open Claude Code in the Prepared Workspace

Your original files are not modified during preparation.

> **Early preview** — not yet recommended for production, regulated data, or highly
> sensitive workflows.

## Three steps

1. **Prepare** — run `Yuhi: Prepare Workspace` (or right-click **Prepare with Yuhi**).
2. **Review** what the AI can see.
3. **Open Claude Code** in the Prepared Workspace.

## Repository Ready

After preparation, Yuhi shows measurable results:

```text
Repository Ready

  Source files             5,224
  Prepared artifacts         317
  Documents prepared          42
  Secrets blocked             18
  Identifiers transformed    103

  Estimated accessible-content reduction: 94%
```

Copy a public-safe summary, or export it as Markdown, JSON, or an SVG badge. Public reports
contain aggregate values only — never filenames, paths, identities, or secret values.

> Estimated reduction is a measure of agent-accessible content, not model token usage or cost.

## What Yuhi prepares

- Blocks credential and private-key files.
- Converts supported documents (PDF / DOCX / PPTX) into sanitized AI-readable companions.
  The original binary is kept out of the Prepared Workspace when conversion succeeds; if
  safe conversion or verification fails, Yuhi keeps the source local or provides a
  placeholder instead of raw document content.
- De-identifies supported structured data.
- Reduces unnecessary repository content.
- **What the AI Can See** — shows which files are available, transformed, excluded, or kept local.
- Provides an Original ↔ Prepared diff before launch.

## Safe review workflow

```text
Original Workspace → Prepare locally → Review what the AI can see
  → Prepared Workspace → Claude Code → Review changes before applying
```

Yuhi never automatically applies agent-generated changes to the Original Workspace.

## Important boundary

Yuhi controls the generated initial context; it is **not an OS sandbox**. A launched agent
may still access files outside the Prepared Workspace, or use the network, when its runtime
or the user permits it.

Yuhi does not upload repository content during preparation or review. Optional local-model
processing uses the locally configured [Ollama](https://ollama.com) runtime. No cloud API
calls are made during preparation or review.

## Requirements

- A folder open in VS Code with a `yuhi.yaml` policy (the extension offers to create one).
- Optional, for on-device document/table summaries: Ollama with a local model
  (**Yuhi: Setup Local AI**).

## Learn more

- Full documentation, commands, and roadmap:
  [github.com/YUHI-AI-Labs/yuhi](https://github.com/YUHI-AI-Labs/yuhi)
- What Yuhi does and does **not** protect against:
  [THREAT_MODEL.md](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/THREAT_MODEL.md)

Apache-2.0 · © YUHI AI Labs
