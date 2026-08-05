# Yuhi — Privacy Platform for Claude Code

**Prepare your workspace before Claude Code sees it.**

Direct personal identifiers are transformed and detected secrets are handled
according to your chosen Privacy Mode — before preparation, during a live Dynamic
Terminal session, and inside the official Claude Code GUI via Native GUI Mode. One
policy, shared by all three surfaces.

![Yuhi preparing a repository and reporting Repository Ready](https://raw.githubusercontent.com/YUHI-AI-Labs/yuhi/v0.4.1/site/demo.gif)

## 1. Privacy

**Privacy Mode** (Balanced / Strict / Trusted Local) decides what happens to direct
personal identifiers — names, emails, phone numbers, and similar values that identify
a person. It is the SAME selector across every surface Yuhi has:

- **Balanced** (default) — direct personal identifiers are transformed; operational
  identifiers (student IDs, course codes, and similar business keys) are preserved so
  analysis and joins keep working.
- **Strict** — the same identifier transform as Balanced, and unverified artifacts
  stay local-only rather than being shared.
- **Trusted Local** — identifier transformation is disabled entirely. Requires
  explicit confirmation before use, and is intended only for a trusted local model or
  private infrastructure — Yuhi does not provide OS-level isolation.

Detected secrets are handled separately from Privacy Mode: Static Prepare redacts
every detected secret unconditionally, in every mode. Dynamic Terminal and Native GUI
Mode default to **Developer Mode**, where project configuration (including `.env`)
may reach Claude Code, and a **Strict** delivery option masks detected secrets before
they leave. Raw secret values are never written to Yuhi's own logs, evidence,
statistics, or UI, in any mode.

Set your Privacy Mode with the `yuhi.privacyMode` setting (Static Prepare) or
`yuhi.dynamicContext.privacyMode` setting (Dynamic Terminal / Native GUI Mode), or let
Yuhi ask once on first use.

## 2. Native Claude GUI

Yuhi does not replace Claude Code with a custom chat UI. It launches the **official
Anthropic Claude Code extension** inside an isolated VS Code environment, and routes
that session through the same Yuhi Gateway that Dynamic Terminal Mode uses — one
privacy runtime, not a separate implementation per surface.

- ✓ Official Claude Code extension
- ✓ Separate VS Code environment (its own `user-data-dir` and `extensions-dir`)
- ✓ No changes to your normal profile
- ✓ Automatic cleanup when the window closes

**Get started**

1. Install Yuhi from the VS Code Marketplace
2. Open a repository
3. Open the Command Palette
4. Run **Yuhi: Open Claude Code Dynamic Workspace**

The official Anthropic Claude Code extension is installed into the isolated Yuhi
environment when required.

## 3. Dynamic Context

Yuhi is not only a prepare-time tool. It observes the test output, JSON and command
output Claude Code produces **during** the session, transforms direct personal
identifiers and handles secrets according to your Privacy Mode, and compresses
eligible results into a representation suited to that content.

```
Tool output
  → Yuhi Gateway
  → privacy transform (identifiers, secrets)
  → compress eligible output
  → retrieve omitted ranges on demand
  → Claude Code
```

A masked value (e.g. `PERSON-001`) stays the same value through compression and a
later retrieval of an omitted range — retrieval re-applies the same privacy policy,
never a raw fallback. Small outputs, and `Read`s that compression could break, may
pass through unchanged. Yuhi does not compress everything Claude Code sends.

Context reduction depends on the content and task. Measurement details are documented
in the benchmark reports; numeric results will be regenerated for v0.5. Dynamic
reduction, when shown, is an estimate of withheld tool-result content — **not** a
reduction in session-wide provider input tokens, billing, or wall-clock time.

## 4. Repository Optimization

Before Claude Code opens, Static Prepare inspects your repository, transforms direct
personal identifiers, redacts detected secrets, and produces a reduced, de-identified
copy — the same Privacy Mode and taxonomy as Dynamic Context and Native GUI Mode,
applied once up front. The Repository Ready report shows what was included,
transformed, or kept local, and why. Numeric reduction figures are repository-specific
and reported per run, not claimed as a fixed number here.

## Bounded Retrieval

Ranges omitted by compression stay in the private store. When Claude Code decides it
needs one, it can fetch only what an authorized locator permits: bounded range ·
locator authorization · exact-output safety rescan (secrets AND direct personal
identifiers) · evidence recording.

Retrieval is **disabled by default** — registering the retrieval tools carries a fixed
token overhead and can add turns and cost on tasks that never need it.

## Isolated Runtime

```
Normal VS Code
    │  Yuhi command
    ▼
Isolated VS Code Window
    ├─ Official Claude Code extension
    ├─ Yuhi Gateway
    ├─ Privacy Mode (Balanced / Strict / Trusted Local)
    └─ Dynamic Context
```

Yuhi does not modify your normal VS Code profile. When the window closes it cleans up
the gateway, MCP registration, session lock and the settings it manages.

## Three ways to use Yuhi

| Experience | Use case |
|---|---|
| **Static Prepare** — `yuhi prepare` | Organizing a repository before handing it to an AI |
| **Dynamic Terminal** — `yuhi launch claude --dynamic-context` | Claude Code CLI / TUI |
| **Native Claude GUI** — *Yuhi: Open Claude Code Dynamic Workspace* | The official Claude Code VS Code extension |

## Authentication

Yuhi does not read, copy, or store your Claude credentials. Existing Claude Code
authentication is supported; **first-time sign-in inside an isolated Yuhi environment
has not yet been validated.** When a sign-in is needed, you sign in through the
official extension's own UI.

## Known limitations

- Native Claude GUI has been validated on **macOS**. Linux and Windows paths are
  implemented and tested, but have not completed a real Claude GUI run.
- Remote SSH, WSL, Dev Containers and Codespaces currently **fail closed** for Native
  GUI Mode.
- First-time sign-in inside a fresh isolated profile has not yet been validated.
- Direct-personal-identifier detection is heuristic: CJK name detection covers 2–4
  character sequences only; a single-character, 5+ character, or non-CJK (Latin
  script) personal name in free text is not detected.
- **In a JSON tool result, a personal field (e.g. `name`) is masked by key only when
  the SAME object also has a recognized operational field (e.g. `student_id`,
  `course_code`) — a deliberate precision trade-off to avoid over-masking ordinary
  API/test-fixture JSON, where a bare `"name"` field is far more likely to be a
  product name than a person's.** A JSON object with personal data and no such
  operational sibling (e.g. `{"name": "...", "email": "...", "message": "..."}`) is
  masked only on its shape-detectable fields (email, phone, and similar) — the `name`
  value itself is left unmasked. Email/phone/similar shape-detectable values are
  always masked regardless of key. "All JSON personal identifiers are transformed" is
  not an accurate description of this behavior.
- Strict Mode secret coverage depends on file format and content; contextless numeric
  identifiers in plain text may remain.
- Developer Mode may retain raw secret values in the private object store when
  required for delivery.
- Dynamic reduction is not the same as total provider-token or cost reduction.
- Token counts are estimates (a calibrated heuristic, weighted differently for CJK and
  Latin-script text) unless an exact tokenizer is configured; they can still be off on
  unusual content.
- Large single-line files and repeated `Read` behaviour may reduce or reverse
  session-level savings.
- The isolated window runs with workspace trust disabled, because VS Code's Restricted
  Mode would otherwise disable both Claude and Yuhi inside it. It applies only to the
  window Yuhi opens, on a workspace Yuhi prepared.

## Requirements

- VS Code 1.85 or newer, Node 18 or newer
- The `claude` CLI for Dynamic Terminal Mode
- macOS for Native Claude GUI (Linux and Windows unverified)

## Learn more

- [Privacy Mode design](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/0.4.8_privacy_mode.md)
- [Native GUI design](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_1_NATIVE_GUI.md)
- [Measured E2E evidence](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_1_NATIVE_GUI_E2E.md)
- [Release scope and permitted claims](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/V0_4_1_RELEASE_SCOPE.md)
- [Developer Mode and the secret boundary](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/design/V0_4_0_DEVELOPER_MODE.md)

Local-first. No accounts, no telemetry. Apache-2.0.
