# Yuhi v0.4.1 — release scope, supported features, and permitted claims

Companion to `design/V0_4_1_NATIVE_GUI.md` (design) and `design/V0_4_1_NATIVE_GUI_E2E.md`
(evidence). This document is the contract: what v0.4.1 promises, what it does not, and what
may be said in public. It extends `V0_4_0_RELEASE_SCOPE.md`, which remains in force for
everything about compression measurement and Developer Mode claims.

## 1. What v0.4.1 adds

> Yuhi can open the **official** Anthropic Claude Code extension in an isolated VS Code
> window whose `claude` process talks through the Yuhi Dynamic Gateway, so tool output is
> compressed, recorded and policy-checked in the normal Claude Code GUI.

Nothing about the runtime changed. The gateway, delivery policy, retrieval policy,
compression kernel, evidence ledger and Safe Apply are the v0.4.0 implementations, shared
with the CLI and Dynamic Terminal Mode.

**In scope:**

* `Yuhi: Open Claude Code Dynamic Workspace`, plus session commands (show, focus, stop,
  recover, diagnostics) in the editor and `yuhi dynamic sessions|stop|recover` in the CLI.
* Isolated VS Code environment: private `--user-data-dir` and `--extensions-dir`.
* Official-extension integration through the documented `claudeCode.environmentVariables`
  setting, merged rather than overwritten.
* Extension contract validation, and installation of the official extension and Yuhi into the
  isolated directory through the VS Code CLI.
* Broker-owned lifecycle: lock, attach handshake, heartbeat, ordered shutdown, stale recovery.
* Developer Mode (default) and Strict Mode; retrieval `disabled` by default.
* Dynamic Terminal Mode retained, unchanged, as a separate route.

**Not in scope, and not release blockers:** Windows GUI verification · Linux GUI verification ·
remote environments (SSH, WSL, Dev Container, Codespaces, web) · multiple concurrent sessions
per workspace · a Yuhi-owned chat UI.

## 2. Supported platforms

| Platform | Status |
|---|---|
| macOS (arm64, VS Code 1.131) | **Supported.** Real GUI evidence recorded. |
| Linux | **Implemented, unverified.** Resolver covers `code`, Insiders, snap, flatpak and known paths; unit-tested; no real GUI run. |
| Windows | **Implemented, unverified.** Falls back with a plain message directing the user to Dynamic Terminal Mode. |
| Remote SSH / WSL / Dev Container / Codespaces / web | **Fail closed** with a message. A local `--user-data-dir` cannot isolate a `claude` process that runs on the far side. |

## 3. Permitted claims

Permitted:

* "Yuhi can run the official Claude Code extension through its dynamic context gateway in an
  isolated VS Code window."
* "Yuhi does not read, copy, or store your Claude authentication credentials."
* "Secret values are not written to Yuhi logs, evidence, statistics, or UI." (unchanged from
  v0.4.0, and enforced by tests that byte-scan Yuhi's own output)
* "Your normal VS Code profile and windows are unaffected."
* Any v0.4.0 compression claim, with its existing qualifiers and the model named.

Prohibited:

* "Native GUI Mode works on Windows / Linux / in remote environments." — unverified or
  unsupported.
* "Secrets are not sent to Claude." — Developer Mode delivers project configuration
  deliberately. (v0.4.0 conflict #4.)
* "Yuhi compresses everything Claude Code sends." — compression targets command output and
  structured data; a `Read` of a log or prose file is deliberately skipped.
* Any claim that Native GUI Mode adds a security control. It adds a *surface*; the controls
  are v0.4.0's and are unchanged.
* Presenting static repository reduction as session, token, or cost reduction.

## 4. Known limitations

1. **macOS only, verified.** Linux and Windows are implemented and unit-tested; neither has a
   real GUI run. Stated in the UI as a fallback message, not silently.
2. **Restricted Mode is disabled in the isolated window.** VS Code's Restricted Mode would
   disable both the official extension and Yuhi, so the isolated window launches with
   `--disable-workspace-trust` and the matching setting. This applies only to the window Yuhi
   created, opening a Prepared Workspace Yuhi produced; the user's normal trust decisions are
   untouched. It is a real reduction in that window's defences and is recorded as such.
3. **One session per Original Workspace.** A second launch offers focus, restart, or cancel.
4. **First launch downloads two extensions** into the isolated directory (the official
   extension and Yuhi), so it is materially slower than later launches.
5. **The session directory is not shared with the normal profile**, so a first sign-in inside
   the isolated window may be required if CLI auth is not already present in `~/.claude`.
6. **Egress guard is a tripwire, not a control** (unchanged from v0.4.0): literal matching
   only, no blocking.
7. **Prepared-workspace reuse** relies on the existing v0.4.0 resolution; Native GUI Mode adds
   no new validation of its own.

## 5. Release gate

| Gate | Required |
|---|---|
| macOS: official Claude GUI opens through Yuhi and reaches the gateway | yes |
| `toolResultBlocksObserved > 0` and `toolResultBlocksCompressed > 0` from real GUI traffic | yes |
| Measured dynamic tool-output reduction from the GUI | yes |
| Developer Mode and Strict Mode both exercised end to end | yes |
| Retrieval `disabled` by default; one bounded retrieval proven | yes |
| Normal VS Code profile and windows unaffected | yes |
| Gateway stops when the window closes; stale sessions recoverable | yes |
| Raw secret in any Yuhi public output = 0 (byte-scanned) | yes |
| Safe Apply / Undo / Rollback unchanged | yes |
| CLI Dynamic Mode and Dynamic Terminal Mode unchanged | yes |
| Fresh VSIX builds and passes structural inspection | yes |
| Linux GUI run · Windows GUI run · remote support | **no** |

Status is recorded in `design/V0_4_1_NATIVE_GUI_E2E.md`.
