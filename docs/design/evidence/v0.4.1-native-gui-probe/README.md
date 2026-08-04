# v0.4.1 Native Claude GUI — Phase 0 probe evidence

Recorded 2026-08-04. Companion to `../../V0_4_1_NATIVE_GUI_FEASIBILITY.md`.

Only the fields below are retained. No raw token, OAuth credential, API key, prompt
history, or absolute personal path appears in this directory — consistent with
`CLAUDE.md` conflict #4 (*evidence/UI NEVER carries a raw value, in any mode*).

## Environment

```
extension        Anthropic.claude-code 2.1.221 (darwin-arm64)
VS Code          1.131.0 (commit e4c7e7b1d6d060162f4aa7f8225271b67ce1df75)
OS               macOS, Darwin 24.3.0
architecture     arm64
gateway URL      http://127.0.0.1:<ephemeral>   (loopback, OS-assigned port)
gateway build    shipped startDynamicClaudeSession — no new proxy was written
delivery mode    developer      retrieval mode  disabled
```

## Probe method

Both probes ran in the same isolated instance and profile:

```
--new-window
--user-data-dir <probe>/user-data
--extensions-dir <probe>/extensions
--profile "Yuhi Dynamic Probe"
--disable-workspace-trust
```

The extension was installed into that profile with
`--install-extension anthropic.claude-code@2.1.221`, version-pinned so the manifest
findings recorded in Phase 0.1 describe exactly what was under test. A CLI-created profile
starts with **no** extensions, so copying the unpacked directory into `--extensions-dir`
was not sufficient — the extension host did not load it and `--list-extensions` for the
profile was empty.

| | Probe A | Probe B |
|---|---|---|
| env in the VS Code process | **set** | **unset** (`env -u`) |
| `claudeCode.environmentVariables` | absent | **present** |
| what it tests | process-environment inheritance | the official documented setting |

## Results

| | Probe A | Probe B |
|---|---|---|
| extension detected | yes | yes |
| extension activated | yes | yes |
| GUI opened | yes | yes |
| prompt submitted | yes (human) | yes (human) |
| `/v1/messages` reached the gateway | **yes** (4) | **yes** (1) |
| model observed | not captured¹ | `claude-opus-5` |
| stream flag | not captured¹ | `true` |
| HTTP status | 200 | 200 |
| upstream response completed | **yes** (usage captured, `upstreamErrors: 0`) | **yes** (usage captured, `upstreamErrors: 0`) |
| gateway attributed the request to a session | yes | yes |
| GUI displayed `YUHI_NATIVE_GUI_PROBE_OK` | **yes** | **yes** |
| live-zone violations | 0 | 0 |
| egress detections | 0 | 0 |
| normal VS Code window affected | **no** (0 leaks / 46 processes) | **no** |
| credential written to disk | **no** | **no** |
| private API used | **no** | **no** |

¹ A harness defect, not an extension finding: the recorder parsed `init.body` only when it
was a string, and `forwardRequest` passes a `Buffer`. Fixed before Probe B. Probe A's
request count, status, attribution and completion are unaffected — only `model` and
`stream` were dropped. Probe A was not re-run a third time to backfill two fields that
Probe B captured from the same extension build.

## Direct evidence that the official setting is what injected the environment

During Probe B, with the VS Code process environment explicitly cleared:

```
extension host (Code Helper (Plugin))   ANTHROPIC_BASE_URL  absent
child claude process (2 PIDs)           ANTHROPIC_BASE_URL  http://127.0.0.1:<ephemeral>
```

The child could only have received it from `claudeCode.environmentVariables`. This is the
observation that makes the official setting the preferred integration path rather than an
assumed one.

## Incidental findings that constrain the implementation

1. **`claudeCode.environmentVariables` is `"scope": "machine"`.** It therefore cannot be set
   from *workspace* settings. Yuhi cannot ship it per-workspace; it must be written to the
   isolated profile's user settings, inside the session's `--user-data-dir`.
2. **The extension health-checks the base URL with `GET /api/hello`** before any
   `/v1/messages`. The Yuhi gateway forwards unknown paths verbatim, so this returned 200
   and startup succeeded. A gateway that answered only `/v1/messages` would break the
   extension at launch.
3. **The extension writes `claudeCode.preferredLocation` into the profile settings itself**
   when the panel is opened. Any Yuhi-managed profile settings file must tolerate the
   extension mutating it concurrently.
4. **A CLI-created profile has no extensions** (see Probe method).

## Files

```
observed-probe-a.jsonl              per-request: ts, path, status  (model/stream absent — see ¹)
observed-probe-b.jsonl              per-request: ts, path, model, stream, status
probe-b-profile-settings.masked.json   the exact setting used, port masked
```

The recorder never reads request headers (they carry the provider credential) and parses the
body solely to extract `model` and `stream`; the prompt text is discarded with the parse.
Source: `scripts/probe-native-gui.ts`.
