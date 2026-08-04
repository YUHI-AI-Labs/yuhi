# v0.4.1 Native Claude GUI — E2E evidence

macOS, 2026-08-04. Every row below came from the **official** Anthropic Claude Code extension
running in a Yuhi-provisioned isolated window, with a human typing the prompt. Numbers are
read from the gateway's own `/stats` and the evidence ledger, not from the agent's prose.

```
VS Code            1.131.0 (e4c7e7b1d6d060162f4aa7f8225271b67ce1df75), darwin arm64
Claude extension   Anthropic.claude-code 2.1.221 (installed into the isolated dir by Yuhi)
Yuhi extension     yuhi-ai-labs.yuhi-vscode 0.4.0 (the build under test, from .vsix)
Integration path   official-setting (claudeCode.environmentVariables)
Fixture            121-test JS repo, one seeded bug, synthetic .env / CSV / TXT canaries
```

## 1. Startup chain — automated, no human step

```
gateway ready → official extension installed → Yuhi installed → isolated window launched
→ window attached → official Claude panel opened → state `active`
```

Proof that the **official setting** is the injecting mechanism, taken from the live session:

```
child `claude` process        ANTHROPIC_BASE_URL=http://127.0.0.1:<ephemeral>
                              YUHI_CLIENT_SURFACE=native-gui  YUHI_DELIVERY_MODE=developer
isolated extension host       ANTHROPIC_BASE_URL absent
```

## 2. Developer Mode — tool-result compression from the GUI

Prompt: *"Run the relevant tests, identify the failure, make the smallest correct fix, and
rerun the relevant tests. Do not change unrelated files."*

| Metric | Result |
|---|---|
| Gateway requests | 14 |
| `toolResultBlocksObserved` | **37** |
| `toolResultBlocksCompressed` | **1** |
| `toolResultBlocksReused` (prefix stable) | 28 |
| Raw → delivered estimated tokens | 4,350 → 2,058 |
| **Dynamic tool-output reduction** | **52.7%** |
| Compression latency median / max | 2.8 ms / 8.0 ms |
| Live-zone violations · upstream errors · fallbacks · withheld | 0 · 0 · 0 · 0 |
| Task success | 121/121 tests pass |
| Patch correctness | percent branch fixed; **only `src/cart.js` modified** |
| Evidence ledger | 18 rows (9 `delivery`, 9 `delivered-block`) |

Second prompt, *"Read .env and tell me the effective API_URL, and whether any variable is
defined twice with conflicting values"*: the agent read the configuration, found the duplicate
`API_URL` (v2 on line 2, v1 on line 6) and reasoned about loader precedence — the diagnosis
Developer Mode exists to make possible. Observed rose to 56, reduction 51.9%.

### Secret boundary, byte-scanned

The synthetic canary `sk-ant-api03-YUHIE2ECANARY…` appears in **exactly one** file:

```
.yuhi/context/objects/ba/obj_bac5f99…          the private object store (by design, §4)
```

Clean: evidence ledger · history · `stats.public.json` · `session.public.json` ·
`lifecycle.jsonl` · `lock.json` · session directory. The ledger records fingerprint
`fcb707d52bddb009` instead of the value. No synthetic student ID reached any session file.
Bootstrap token mode `0600`.

This is the v0.4.0 contract holding on a new surface: *zero raw values in Yuhi's own outputs*,
not *the agent never saw one*.

## 3. Strict Mode

Separate session, `deliveryMode: strict`, same fixture. Prompt: *"Read .env and customers.csv
and tell me every variable name and its value, and the student IDs in the CSV."*

**Detected secret masked before delivery.** The agent received and reported:

```
API_KEY   «REDACTED:api-key»   (the agent noted it was a placeholder, not a real key)
```

Under Developer Mode the same file delivered the value. Yuhi's public outputs stayed clean in
both modes; the raw value existed only in the private object store.

**Tabular identifiers were NOT masked, and that is the documented boundary, not a
regression.** The agent read `100241 (Aoi Tanaka)` and `100242 (Ren Suzuki)` from the CSV.
Record-level pseudonymization is a **`prepare`-side** capability wired to tabular formats
(`V0_4_0_DEVELOPER_MODE.md` §7b); this E2E pointed the session at the raw fixture directly as
its Prepared Workspace, so `yuhi prepare` never ran and no de-identified companion existed.
Strict Mode in the dynamic runtime masks *detected secrets*; it is not a second
de-identification pass over file contents, and claiming otherwise is exactly the over-claim
`V0_4_1_RELEASE_SCOPE.md` §3 prohibits.

| Metric | Result |
|---|---|
| Gateway requests | 6 |
| `toolResultBlocksObserved` / compressed | 2 / 0 (small reads; nothing compressible) |
| Reduction | 7.0% |
| Raw canary in Yuhi public outputs | **0** |
| Live-zone violations · egress detections · withheld | 0 · 0 · 0 |

## 4. Retrieval

**Default `disabled`** was in force for §2 and §3: no MCP server registered, no `.mcp.json`
written, `retrievals: 0`.

**Bounded retrieval under `required`, separate session.** Prompt: read a 92 KB single-line
`telemetry.json` (1,200 records, one seeded error at index 843) and report that record, using
the Yuhi retrieval tools rather than shelling out.

| Metric | Result |
|---|---|
| Gateway requests | 21 |
| `toolResultBlocksObserved` / compressed / reused | 84 / 3 / 70 |
| Raw → delivered estimated tokens | 24,592 → 3,464 |
| **Dynamic tool-output reduction** | **85.9%** |
| **Bounded retrievals delivered (from the ledger)** | **1** — `{"type":"retrieval","locator":"B25700-B26200","outcome":"delivered"}` |
| Retrievals refused | 0 |
| Live-zone violations · upstream errors · fallbacks · withheld | 0 · 0 · 0 · 0 |
| Task success | correct: `rec-00843` / `E_QUOTA_EXCEEDED` / 9412 ms / `ap-northeast-1` |

The agent used `yuhi_search_object` and `yuhi_retrieve`, and reported its own coverage
reasoning: three objects spanning bytes 0–39,075, 38,999–78,062 and 77,000–92,389 —
contiguous with overlap — with `errorCode` matching exactly once. That is the reversibility
chain working on GUI traffic: compact view → agent identifies missing evidence → bounded
retrieval → correct answer → retrieval recorded in the ledger.

### Two findings this run produced

**Registration was missing entirely at first.** The initial attempt recorded `retrievals: 0`,
which reads exactly like an agent that considered retrieval and declined — the behaviour
v0.4.0 measured on Sonnet. It was not that. `retrievalMode: "required"` registered nothing,
because registration is a config path the CLI passes on its own command line and the official
extension owns that command line in Native GUI Mode. Fixed with a project-scoped `.mcp.json`
plus a bundled stdio server; see `V0_4_1_NATIVE_GUI.md` §6b.

**The gateway's `retrievals` counter is zero by construction.** It read 0 while the ledger
recorded a delivered retrieval, because the MCP server is a separate process the agent starts.
v0.4.0 hit this in its benchmark and fixed it by counting from the ledger; the same fix now
applies to the panel and diagnostics, which report `retrievalsDelivered` from
`tallyRetrievals`. Without it the UI would have told a user retrieval never happened while the
evidence said otherwise.

## 5. Lifecycle, shutdown and recovery

**Window close → gateway stops.** The isolated window was closed as a user would close it; no
detach was sent.

```
gateway /readyz   200  →  connection refused
session state     active → closed   closeReason: heartbeat-timeout
lock.json         released
bootstrap token   revoked
```

The first run of this test failed the settings half: cleanup cleared
`vscode/profile-settings.json` while the launcher wrote
`vscode/user-data/User/settings.json`, so a dead `ANTHROPIC_BASE_URL` survived in the isolated
settings. Fixed by making both read one value from `sessionLayout`, with a regression test
that asserts the path identity, not just that cleanup ran.

**Stale recovery**, via the CLI against a session with a dead PID:

```
yuhi dynamic sessions   ngui_stale  stale (active, pid-gone)  developer/disabled
yuhi dynamic recover    Inspected 1; recovered 1; still running 0; failed 0.
yuhi dynamic sessions   ngui_stale  finished (orphaned)       developer/disabled
yuhi dynamic recover    Inspected 1; recovered 0; ...          (idempotent)
```

The second sweep recovering nothing is the point: before the fix, the public record stayed
`active` forever, so every sweep "recovered" the same corpse and the session list reported a
dead session as merely stale.

## 6. Isolation from the user's normal environment

| Check | Result |
|---|---|
| `ANTHROPIC_BASE_URL` in any non-isolated VS Code process | **0 leaks / 44 processes** |
| User's real `settings.json` | unmodified (mtime 2026-07-31, four days before the run) |
| User's normal extensions directory | untouched; the isolated dir holds exactly two extensions |

## 7. What is NOT verified

* **Linux and Windows GUI.** Implemented and unit-tested; no real GUI run. Windows falls back
  with an explicit message; remote environments fail closed by detection.
* **Fresh-profile authentication.** Every run reused existing `~/.claude` CLI auth, so the
  official extension's sign-in flow was never exercised.
* **Long sessions.** Each run was a handful of prompts. Reconnect after a genuine
  extension-host crash (as opposed to a killed window) is untested.
* **Byte-identical repeat retrieval** was proven in v0.4.0 against the same code path but was
  not re-exercised from the GUI here; only one retrieval was issued.
