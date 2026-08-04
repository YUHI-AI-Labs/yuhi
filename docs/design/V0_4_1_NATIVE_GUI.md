# v0.4.1 — Native Claude GUI Mode

Architecture, settings injection, extension contract, lifecycle, security and authentication
for running the **official** Anthropic Claude Code extension through the Yuhi Dynamic
Runtime. The feasibility evidence that authorised this design is in
`V0_4_1_NATIVE_GUI_FEASIBILITY.md` §5; the measured E2E results are in
`V0_4_1_NATIVE_GUI_E2E.md`; the claims contract is `../V0_4_1_RELEASE_SCOPE.md`.

---

## 1. Shape

```
Yuhi: Open Claude Code Dynamic Workspace   (normal window)
        ↓
   resolve / prepare workspace
        ↓
   spawn BROKER  (detached node process, dist/native-broker.js)
        │
        ├── startDynamicClaudeSession()  ── Context Gateway (127.0.0.1:<ephemeral>)
        ├── install Anthropic.claude-code + yuhi-ai-labs.yuhi-vscode into an isolated dir
        ├── merge claudeCode.environmentVariables into isolated user settings
        ├── launch isolated VS Code window
        └── attach server (loopback, token-guarded)
                    ↑ attach · heartbeat · detach        ↑ status · stop · focus
             isolated window's Yuhi ext            originating window
                    ↓
             claude-vscode.sidebar.open  →  official Claude GUI
                    ↓
             claude CLI child  ──ANTHROPIC_BASE_URL──▶  Yuhi Gateway ──▶ upstream
```

**Nothing in Native GUI Mode is a second implementation.** The gateway, delivery policy,
retrieval policy, compression kernel, evidence ledger, metrics and Safe Apply all come from
v0.4.0 via `startDynamicClaudeSession` — the same call behind `yuhi launch claude
--dynamic-context` and Dynamic Terminal Mode. What v0.4.1 adds is the isolated VS Code
environment and the lifecycle around it.

Dynamic Terminal Mode (`Yuhi: Start Claude Code with Dynamic Context`) is unchanged and
remains the supported path on Windows and in remote environments.

## 2. Why the broker is a separate process

The gateway is an in-process HTTP server. If it lived in the originating window's extension
host then a window reload would either strand a listening socket or kill the gateway out from
under the isolated window that depends on it. No existing long-lived Yuhi process covers this
flow. So the broker is spawned detached and owns the session: gateway, lock, heartbeat and
cleanup. It is deliberately small — one module plus an eight-line VSIX entry — and it exits
as soon as the session closes.

Requirements it satisfies: the originating extension host may reload or exit without losing
the session; gateway and window shutdown are managed in one place; stale sessions are
recoverable from disk; and no session state leaks into the normal window.

## 3. Settings injection (the primary integration path)

`claudeCode.environmentVariables` is the documented, first-party channel to the `claude`
child process. Three facts from the probe shape the implementation:

| Fact | Consequence |
|---|---|
| The setting is `"scope": "machine"` | It cannot come from workspace settings. Yuhi **cannot ship it per-workspace**; it goes into the isolated user-data-dir's user settings. |
| The official extension writes to that same file (`claudeCode.preferredLocation`) | Yuhi **merges, never overwrites**. An overwrite would silently revert the extension's own state. |
| Its item schema is `{ name: string, value: string }` | Validated from the manifest, not assumed. A future shape change is detected rather than silently dropping the endpoint. |

Seven keys are Yuhi-managed and replaced on every launch; every other entry in the array is
preserved, and a user's duplicate key is collapsed to one (last definition wins):

```
ANTHROPIC_BASE_URL   YUHI_SESSION_ID    YUHI_CONTEXT_ROOT    YUHI_DYNAMIC_CONTEXT
YUHI_CLIENT_SURFACE  YUHI_DELIVERY_MODE YUHI_RETRIEVAL_MODE
```

None of them is a credential. They are removed again on close, so a stale endpoint cannot be
reused by a later launch.

**Fallback.** Process-environment inheritance also works (Probe A) and is kept only for the
case where the setting is unavailable. It reaches *every* child of the isolated window rather
than `claude` alone, so it is warned about explicitly:

> Claude Code is using process-wide Gateway environment in this isolated Window.

Injecting into the user's normal window is forbidden in both paths.

## 4. Isolation

```
--new-window --user-data-dir <session>/vscode/user-data --extensions-dir <session>/vscode/extensions <prepared>
```

`--profile` is **not** used. It adds nothing — the user-data-dir is already Yuhi's own, so its
default profile is private by construction — and it breaks two things discovered in real runs:
`--install-extension --profile X` fails with *"Profile 'X' not found"* before that profile has
ever been created, and a CLI-created profile starts with **no extensions**, so the extension
host loads nothing. Visual distinction comes from `workbench.colorCustomizations` in the
isolated settings instead.

## 5. Extension contract

Version-pinning forever would break Native GUI Mode on the user's first update, so the gate is
a contract validated from the installed manifest — public surface only, no private module, no
webview, no guessed command id:

```
publisher = Anthropic · id = Anthropic.claude-code
contributes claudeCode.environmentVariables, array of { name, value }
contributes one of claude-vscode.sidebar.open | .window.open | .editor.open
```

Any version satisfying all four is accepted; `2.1.221` is recorded as the tested build. A
broken contract is reported, never worked around:

> Installed Claude Code extension is incompatible with Yuhi Native GUI Mode.
> → Install tested version · Use Dynamic Terminal Mode · Cancel

Both the official extension and Yuhi itself are installed into the isolated directory through
the VS Code CLI. Copying an unpacked directory appears to work and then silently does not.
Yuhi never bundles or redistributes the Claude extension.

## 6. Lifecycle

Nineteen states rather than "starting", because a stalled session needs a different remedy
depending on whether VS Code never launched, the extension never installed, or the window
launched and never attached. Illegal transitions are recorded as `failed` rather than dropped
— the recovery sweep needs something to act on.

**Attach.** A session id is an identifier, not a capability: it travels in settings and in
diagnostics by design. Authorisation is a 256-bit bootstrap token, written `0o600` under
`private/`, compared in constant time, and revoked on close. Heartbeat and the control routes
(`status`, `stop`, `focus`) are token-guarded too, so an unauthenticated caller can neither
keep a dead session's lock warm nor stop a live one.

**Heartbeat.** The isolated window beats every 5 s; the broker gives up after 30 s. The gap is
deliberate — an extension-host reload takes seconds and is normal.

**Locking.** One active session per Original Workspace. A lock is live only when the workspace
hash matches, the PID is alive, *and* the heartbeat is fresh. PID alone is never sufficient:
PIDs are recycled, and acting on a recycled one is the difference between reusing a session and
killing an unrelated process. A double launch offers *Focus existing Window · Stop and restart ·
Cancel*.

**Shutdown** is ordered and each step is independently guarded, because one failure must never
strand a listening gateway:

```
stop heartbeat → stop attach server → flush evidence → close gateway
→ clear managed settings → revoke token → release lock
```

Evidence flushes before the gateway closes (the gateway owns the writer); the token is revoked
before the lock is released (so a window reconnecting in the gap cannot re-attach to a session
that is tearing down); the lock is released last (it is what recovery reads).

**Recovery.** `yuhi dynamic sessions` / `stop` / `recover`, and the equivalent commands in the
editor, classify each session on disk as live, stale, finished or unreadable and finish the
shutdown that never completed. Recovery **never signals a process it does not own** — it
releases Yuhi's own artefacts only, and leaves any VS Code the user may still be using alone.

## 7. Security

Native GUI Mode defines **no** security logic of its own. Detection, delivery policy, key-
material masking, the exact-output rescan, the egress guard and the evidence schema are the
v0.4.0 implementations, unchanged, shared with the CLI and Dynamic Terminal Mode. Developer
Mode remains the default and Strict Mode remains selectable; both notices are the shared text.
See `V0_4_0_DEVELOPER_MODE.md` and `CLAUDE.md` conflict #4.

What v0.4.1 adds is a new set of surfaces that must not carry raw values — session records,
lifecycle logs, stats, diagnostics, status text, error messages and exports:

```
public/     session id · state · workspace HASH · modes · versions · counts
private/    bootstrap token (0600) · gateway endpoint · source binding · auth state
never       absolute path · credential · OAuth token · prompt text · context bytes
```

`redactForExport` is the single choke point for diagnostics, and the security suite byte-scans
its output — plus the public session record — against synthetic canaries, so widening a field
fails the build instead of shipping.

## 8. Authentication

Yuhi does not participate in authentication. It does not read, copy, store, or proxy a
credential; it does not duplicate `~/.claude`, intercept an auth callback, or automate a
browser login. The `claude` child's own auth headers pass through the gateway untouched, as
they already do for the CLI.

When the isolated window has no usable auth, the user signs in through the **official**
extension's own UI:

> Sign in through the official Claude Code extension.
> Yuhi does not read or store your authentication credentials.

Four failures are reported distinctly rather than collapsed into "Gateway failed": not signed
in · gateway unreachable · upstream rejected the credential · official extension error.

## 9. Platforms

| | Status |
|---|---|
| macOS | Supported; real GUI E2E evidence in `V0_4_1_NATIVE_GUI_E2E.md`. |
| Linux | Implemented (resolver covers `code`, Insiders, snap, flatpak, known paths) and unit-tested. **No real GUI run** — see the E2E document. |
| Windows | Resolver and launcher paths implemented; **unverified**. Falls back with: *Native GUI Mode is not yet available on this Windows environment. Use Dynamic Terminal Mode.* |
| Remote SSH / WSL / Dev Container / Codespaces / web | **Fail closed** by detection: *Native GUI Mode currently supports local workspaces. Use Dynamic Terminal Mode in remote environments.* A local `--user-data-dir` would isolate nothing when the `claude` child runs on the far side. |

## 10. Deliberate deviations from the v0.4.1 directive

1. **Session state lives under the existing Yuhi home** (`~/.yuhi/native-sessions/`, honouring
   `YUHI_HOME`) rather than a second platform-specific application-data root. One home keeps
   sessions, recovery and cleanup looking in a single place on every OS.
2. **Context store, prefix state and evidence stay in the Prepared Workspace**
   (`<prepared>/.yuhi/context`), where the shared launcher puts them. Relocating them under the
   session directory would mean forking `startDynamicClaudeSession` or lying to it about the
   store root — either one splits the runtime all three surfaces are required to share. The
   session's `private/` holds what is genuinely session-scoped.
3. **`--profile` is not passed** (§4).
