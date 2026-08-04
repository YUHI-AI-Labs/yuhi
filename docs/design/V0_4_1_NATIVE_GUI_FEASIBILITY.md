# v0.4.1 Native Claude GUI — Feasibility Gate (Phase 0)

Branch: `feature/v0.4.1-native-claude-gui`, cut from the published `main` at `70d4eba` (v0.4.0).
Status: **Phase 0.1 complete. Phase 0.2/0.3 NOT run — the gate is UNPROVEN.**

This document exists so the next session does not rediscover any of it. Nothing here may be
treated as a PASS: no traffic has been observed through a gateway from the official
extension yet.

---

## 0. Where v0.4.0 landed (context, not work)

```
main            70d4eba   release: v0.4.0 — Dynamic Context Runtime
tag             v0.4.0
npm             @yuhi-ai-labs/yuhi@0.4.0  (latest)
GitHub Release  https://github.com/YUHI-AI-Labs/yuhi/releases/tag/v0.4.0  (VSIX attached)
Marketplace     yuhi-ai-labs.yuhi-vscode 0.4.0 — published by the maintainer
Site            https://yuhi-iota.vercel.app (project `yuhi`, org team_ZdXlxwgNpI89ktDfGPHtQa0X)
Gate            1135 tests · typecheck 0 · lint 0 errors · build ok
```

Everything v0.4.1 needs already exists and **must not be reimplemented**: the gateway,
delivery policy (`developer` | `strict`), retrieval modes (default `disabled`), evidence
ledger, compression kernel, Safe Apply, and the shared launcher
`startDynamicClaudeSession()` in `packages/context-gateway/src/launch-session.ts`.

---

## 1. Phase 0.1 — the official extension (VERIFIED)

Read from the installed manifest only. No private module was imported, no webview inspected.

```
id            Anthropic.claude-code
version       2.1.221  (darwin-arm64 build)
manifest      ~/.vscode/extensions/anthropic.claude-code-2.1.221-darwin-arm64/package.json
main          ./extension.js
activation    onStartupFinished · onWebviewPanel:claudeVSCodePanel
```

### Public commands (usable via `executeCommand`, no guessing required)

```
claude-vscode.editor.open          claude-vscode.editor.openLast
claude-vscode.primaryEditor.open   claude-vscode.window.open
claude-vscode.sidebar.open         claude-vscode.newConversation
claude-vscode.reopenClosedSession  claude-vscode.focus / .blur
claude-vscode.createWorktree       claude-vscode.update   claude-vscode.logout
```

`claude-vscode.sidebar.open` and `claude-vscode.window.open` are the candidates for the
adapter's `open()`. Existence is confirmed from the manifest; behaviour is not yet tested.

### Contributed settings — the finding that changes the plan

```
claudeCode.environmentVariables   array, default []
    "Environment variables to set when launching Claude.
     Prefer setting environment variables in Claude's settings.json."
claudeCode.claudeProcessWrapper   string, default null
    "Executable path used to launch the Claude process."
claudeCode.useTerminal            boolean, default false
    "Launch Claude in the terminal instead of the native UI."
```

**The extension launches the `claude` CLI as a child process, and exposes a DOCUMENTED
setting for that child's environment.** That reframes the whole gate:

- The v0.4.1 directive assumed we must make the extension honour an inherited
  `ANTHROPIC_BASE_URL` from an isolated VS Code process. That may work — the child would
  normally inherit the extension host's environment — but it is not the only path, and it is
  not the documented one.
- `claudeCode.environmentVariables` in the **isolated profile's settings** is a supported,
  first-party mechanism to point that child at the Yuhi gateway. It is a setting, not a hack:
  no private API, no undocumented storage, no patching.
- The isolation rule still holds. The setting would live in the Yuhi Dynamic profile's
  `settings.json` under the session's `--user-data-dir`, so it cannot touch the user's normal
  window.

Both paths must be tested in Phase 0.2, in this order:

1. **Inherited env** — launch the isolated VS Code with `ANTHROPIC_BASE_URL` in its
   environment and see whether the spawned `claude` inherits it. Cleanest if it works.
2. **Documented setting** — put `ANTHROPIC_BASE_URL` into `claudeCode.environmentVariables`
   in the isolated profile. Expected to work; uses a supported contract.

If (1) works, prefer it (nothing written to a settings file). If only (2) works, that is
still a PASS for the gate, but the design must record that the gateway endpoint is written
into a profile settings file inside the session directory — and that file must be cleaned up
on session close, and must never contain a credential.

---

## 2. Phase 0.2 — probe procedure (NOT RUN)

```
/tmp/yuhi-native-gui-probe/
  user-data/    extensions/    workspace/    logs/
```

```bash
# 1. install the official extension into the ISOLATED extensions dir (ask first)
code --user-data-dir /tmp/yuhi-native-gui-probe/user-data \
     --extensions-dir /tmp/yuhi-native-gui-probe/extensions \
     --install-extension anthropic.claude-code

# 2. start a probe gateway (any scratch store root) and note its URL
#    packages/context-gateway/src/index.ts → startGateway({ storeRoot, sessionOverride })

# 3. launch the isolated window with the env under test
env ANTHROPIC_BASE_URL=http://127.0.0.1:<port> \
    YUHI_DYNAMIC_CONTEXT=1 YUHI_SESSION_ID=<probe> YUHI_CONTEXT_ROOT=<ctx> \
  code --new-window \
       --user-data-dir /tmp/yuhi-native-gui-probe/user-data \
       --extensions-dir /tmp/yuhi-native-gui-probe/extensions \
       --profile "Yuhi Dynamic Probe" \
       /tmp/yuhi-native-gui-probe/workspace
```

**Phase 0.3 needs a human.** In that window, open the Claude extension and send exactly:

```
Reply exactly: YUHI_NATIVE_GUI_PROBE_OK
```

Then check the gateway: `requests > 0`, `/v1/messages` reached, upstream completed, and the
evidence ledger under the probe context root has a delivery row. Also confirm the user's
normal window is unchanged (its `ANTHROPIC_BASE_URL` still empty, colours and settings
untouched).

## 3. PASS / FAIL

PASS requires all of: extension detected · extension opens · prompt sends · gateway receives
the request · upstream completes · GUI shows the response · normal window unaffected · no
credential written to disk.

FAIL if the extension ignores both env paths, talks through a channel the gateway cannot
see, or requires an authentication path we cannot support. On FAIL: **do not start the
implementation.** Report what was tested, the extension version, the observed network path,
and evaluate only the four recorded alternatives (keep Dynamic Terminal Mode · ask Anthropic
for official base-url support · use a documented setting if one exists · Yuhi-owned webview
only on an explicit product decision).

## 4. Inherited constraints (do not re-decide)

- Delivery mode default `developer`; `strict` selectable. Same policy object, same notices,
  same evidence schema as CLI and Dynamic Terminal. Do not write a new secret policy.
- Retrieval default `disabled` — measured: registering the MCP tools costs ~507 fixed tokens
  plus agent turns, and turned a 20% cost win into a 31% loss on a task that needed none.
- Never mutate the existing window's extension-host environment
  (`process.env.ANTHROPIC_BASE_URL = …` is forbidden).
- Do not bundle or redistribute the Claude Code extension.
- Windows may stay unsupported in v0.4.1 if stated plainly; Linux GUI E2E is a release
  blocker and must not be marked PASS without a real run.
