# Yuhi — Dynamic Context for Claude Code

**Use the official Claude Code GUI through Yuhi Dynamic Context.**

Compress eligible tool outputs, retrieve omitted context when needed, and keep the session
isolated from your normal VS Code environment.

![Yuhi preparing a repository and reporting Repository Ready](https://raw.githubusercontent.com/YUHI-AI-Labs/yuhi/v0.4.1/site/demo.gif)

## Native Claude GUI

Yuhi does not replace Claude Code with a custom chat UI. It launches the **official Anthropic
Claude Code extension** inside an isolated VS Code environment, and routes that session through
Yuhi Dynamic Context.

- ✓ Official Claude Code extension
- ✓ Separate VS Code environment (its own `user-data-dir` and `extensions-dir`)
- ✓ No changes to your normal profile
- ✓ Automatic cleanup when the window closes

**Get started**

1. Install Yuhi from the VS Code Marketplace
2. Open a repository
3. Open the Command Palette
4. Run **Yuhi: Open Claude Code Dynamic Workspace**

The official Anthropic Claude Code extension is installed into the isolated Yuhi environment
when required.

## Dynamic Context

Yuhi is not only a prepare-time tool. It observes the test output, JSON and command output
Claude Code produces **during** the session and compresses eligible results into a
representation suited to that content.

```
Large tool output
  → Yuhi Gateway
  → compress only eligible output
  → retrieve omitted ranges on demand
  → Claude Code
```

Small outputs, and `Read`s that compression could break, may pass through unchanged. Yuhi does
not compress everything Claude Code sends.

### Measured examples (real Claude Code GUI)

- **Developer Mode run** — 37 tool results observed, 1 eligible block compressed, 52.7%
  estimated dynamic tool-output reduction, 121/121 tests passed, one file changed.
- **Retrieval run** — 84 tool results observed, 3 eligible blocks compressed, 85.9% estimated
  dynamic tool-output reduction, 1 bounded retrieval that returned the correct record.

Dynamic reduction is the estimated reduction in delivered tool-result blocks that the Gateway
transformed. It is **not** a reduction in session-wide provider input tokens, billing, or
wall-clock time. Results vary by task, model, Claude Code behaviour, caching and retrieval
configuration.

## Delivery Modes

### Developer Mode — default

- Claude Code may use project configuration, including `.env` files.
- Raw values required for delivery may exist inside Yuhi's private object store.
- Raw secret values are excluded from Yuhi public logs, statistics, UI, diagnostics and
  exported evidence.

### Strict Mode

- Detected secrets and supported identifiers are masked before delivery.
- Coverage depends on file format and content. This does not guarantee removal of every secret
  or identifier.

## Bounded Retrieval

Ranges omitted by compression stay in the private store. When Claude Code decides it needs one,
it can fetch only what an authorized locator permits: bounded range · locator authorization ·
exact-output safety rescan · evidence recording.

Retrieval is **disabled by default** — registering the retrieval tools carries a fixed token
overhead and can add turns and cost on tasks that never need it.

## Isolated Runtime

```
Normal VS Code
    │  Yuhi command
    ▼
Isolated VS Code Window
    ├─ Official Claude Code extension
    ├─ Yuhi Gateway
    ├─ Developer / Strict Mode
    └─ Dynamic Context
```

Yuhi does not modify your normal VS Code profile. When the window closes it cleans up the
gateway, MCP registration, session lock and the settings it manages.

## Three ways to use Yuhi

| Experience | Use case |
|---|---|
| **Static Prepare** — `yuhi prepare` | Organizing a repository before handing it to an AI |
| **Dynamic Terminal** — `yuhi launch claude --dynamic-context` | Claude Code CLI / TUI |
| **Native Claude GUI** — *Yuhi: Open Claude Code Dynamic Workspace* | The official Claude Code VS Code extension |

## Authentication

Yuhi does not read, copy, or store your Claude credentials. Existing Claude Code authentication
is supported; **first-time sign-in inside an isolated Yuhi environment has not yet been
validated.** When a sign-in is needed, you sign in through the official extension's own UI.

## Known limitations

- Native Claude GUI has been validated on **macOS**. Linux and Windows paths are implemented and
  tested, but have not completed a real Claude GUI run.
- Remote SSH, WSL, Dev Containers and Codespaces currently **fail closed** for Native GUI Mode.
- First-time sign-in inside a fresh isolated profile has not yet been validated.
- Strict Mode coverage depends on file format and content; contextless numeric identifiers in
  plain text may remain.
- Developer Mode may retain raw values in the private object store when required for delivery.
- Dynamic reduction is not the same as total provider-token or cost reduction.
- Absolute token counts currently use a fallback heuristic and can be well off on dense data.
- Large single-line files and repeated `Read` behaviour may reduce or reverse session-level
  savings.
- The isolated window runs with workspace trust disabled, because VS Code's Restricted Mode
  would otherwise disable both Claude and Yuhi inside it. It applies only to the window Yuhi
  opens, on a workspace Yuhi prepared.

## Requirements

- VS Code 1.85 or newer, Node 18 or newer
- The `claude` CLI for Dynamic Terminal Mode
- macOS for Native Claude GUI (Linux and Windows unverified)

## Learn more

- [Native GUI design](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_1_NATIVE_GUI.md)
- [Measured E2E evidence](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_1_NATIVE_GUI_E2E.md)
- [Release scope and permitted claims](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/V0_4_1_RELEASE_SCOPE.md)
- [Developer Mode and the secret boundary](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_0_DEVELOPER_MODE.md)

Local-first. No accounts, no telemetry. Apache-2.0.
