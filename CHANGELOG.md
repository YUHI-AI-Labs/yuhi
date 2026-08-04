# Changelog

## 0.4.1 — Native Claude GUI Mode

Yuhi can now open the **official** Anthropic Claude Code extension in an isolated VS Code
window whose `claude` process runs through the Yuhi Dynamic Gateway. The normal Claude Code
GUI, with tool output compressed, recorded and policy-checked on the way past.

### Added

- **`Yuhi: Open Claude Code Dynamic Workspace`** — prepares or reuses a Prepared Workspace,
  starts the gateway, provisions an isolated VS Code environment, installs and validates the
  official extension, and opens the Claude panel.
- Session management: `Yuhi: Show / Focus / Stop / Recover Native Dynamic Sessions` and
  `Yuhi: Show Native Dynamic Diagnostics`, plus `yuhi dynamic sessions | stop <id> | recover`.
- A broker process that owns each session, so a window reload or close never strands a
  gateway, and stale sessions can be recovered.

### Notes

- **Your normal VS Code profile and windows are unaffected.** Isolation is a private
  `--user-data-dir` and `--extensions-dir`.
- **Yuhi does not read, copy, or store Claude credentials.** Sign-in, when needed, happens in
  the official extension's own UI.
- The isolated window runs with workspace trust disabled — VS Code's Restricted Mode would
  otherwise disable both Claude and Yuhi inside it. It applies only to the window Yuhi opens,
  on a workspace Yuhi prepared.
- **macOS verified.** Linux and Windows are implemented but not verified on a real GUI.
  Remote environments (SSH, WSL, Dev Containers, Codespaces) are unsupported and say so.
- Dynamic Terminal Mode, the CLI, Developer/Strict Mode, retrieval defaults and Safe Apply
  are unchanged. Native GUI Mode adds no security logic of its own; it reuses v0.4.0's.

## 0.4.0 — Dynamic Context Runtime

Claude Code runs through a local Yuhi gateway: every new tool result is stored privately,
scanned, compressed and re-scanned before it reaches the provider, and everything withheld
stays retrievable. Defaults to Developer Mode. See
[docs/design/V0_4_0_DEVELOPER_MODE.md](docs/design/V0_4_0_DEVELOPER_MODE.md).
