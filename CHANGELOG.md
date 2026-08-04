# Changelog

## 0.4.5 — new Marketplace display name

**The VS Code extension display name is now `Yuhi Code — See What Your AI Agent Sees`.**
No behaviour changes.

The removed listing reserved its display name as well as its id, so 0.4.4's display name
was rejected on upload for the same reason its predecessor's id was. This release changes
the display name so the extension can be published.

`v0.4.4` was tagged but **never published** to npm, the Marketplace or a GitHub Release.
It is superseded by 0.4.5; nothing consumed it.

### Changed

- Display name `Yuhi Code — See What Your AI Agent Sees` (was
  `Yuhi — Dynamic Context for Claude Code`). It matches the project's own tagline and,
  unlike a "secure" or "private" phrasing, claims a capability rather than a guarantee —
  consistent with the standing rule against implying guaranteed safety.
- CLI ships 0.4.5 to stay in lockstep with the extension.

### Unchanged

Extension id stays `yuhi-ai-labs.yuhi-code` (introduced in 0.4.4).
`@yuhi-ai-labs/yuhi@0.4.3` on npm remains installable.

## 0.4.5 — new Marketplace display name

**The VS Code extension display name is now `Yuhi Code — See What Your AI Agent Sees`.**
No behaviour changes.

Both the extension name and the display name of the removed listing are permanently
reserved by the Marketplace, so 0.4.4's display name was rejected on upload for the same
reason its predecessor's id was. This release changes the display name so the extension
can be published.

`v0.4.4` was tagged but **never published** to npm, the Marketplace or a GitHub Release;
it is superseded by 0.4.5. Nothing consumed it.

### Changed

- Display name `Yuhi Code — See What Your AI Agent Sees` (was
  `Yuhi — Dynamic Context for Claude Code`). It matches the project's own tagline and,
  unlike a "secure"/"private" phrasing, claims a capability rather than a guarantee —
  consistent with the standing rule against implying guaranteed safety.
- CLI ships 0.4.5 to stay in lockstep with the extension.

### Unchanged

Extension id stays `yuhi-ai-labs.yuhi-code` (introduced in 0.4.4).
`@yuhi-ai-labs/yuhi@0.4.3` on npm remains installable.

## 0.4.4 — new VS Code Marketplace extension id

**The VS Code extension id changed from `yuhi-ai-labs.yuhi-vscode` to
`yuhi-ai-labs.yuhi-code`.** No other behaviour changes.

The previous listing was removed from the Marketplace, and a removed extension name is
permanently reserved — per Microsoft's publishing documentation it "cannot be reused,
even by the original publisher". `yuhi-ai-labs.yuhi-vscode` can therefore never serve a
release again, so 0.4.4 moves to a new id.

### If you had the extension installed

Install **Yuhi** from the Marketplace again under the new id. The old entry will never
update. Settings, keybindings and prepared workspaces are unaffected.

### Changed

- Extension id `yuhi-ai-labs.yuhi-code` (`name: "yuhi-code"`).
- Native GUI Mode resolves the new id. The id was hardcoded in three places; it is now
  read from the single `YUHI_EXTENSION_ID` constant everywhere, guarded by a test that
  fails if the retired id reappears in shipped source or if the constant and the
  extension manifest drift apart.
- The CLI ships 0.4.4 too: it bundles the same gateway code and owns
  `yuhi dynamic sessions | stop | recover`, so a 0.4.3 CLI would still resolve the dead
  id.
- README badges and install links point at the new id. Dated 0.4.0 measurement records
  in `docs/design/` keep the old id, because they describe what was measured then.

### Unchanged

`@yuhi-ai-labs/yuhi@0.4.3` on npm is unaffected and remains installable; 0.4.4 is the
same code with the new extension identity. Everything in the 0.4.3 notes below still
applies.

## 0.4.3 — Real-data privacy and reporting fixes

Correctness fixes found by auditing a real tabular workspace. **No new features.**

### Fixed

- **Headerless tables leaked their first record.** The transform and the final privacy
  verifier both derived the body start from the same heuristic, which only recognized row 0
  as data when it held an email address or a phone number. A roster of id/name/course/grade
  was therefore treated as headed: row 0 passed through raw AND was invisible to the gate, so
  a raw identifier in the delivered bytes could coexist with `identifierLeaks: 0`.
  Verification no longer shares the transform's header/body guess, and a single multi-column
  row is now a table (a single-record export used to be delivered whole).
- **A raw fallback reported itself as "No".** `rawFallbackUsed` was typed as the literal
  `false`, the CLI printed it as a hardcoded string, a FAILED privacy scan rendered as "Not
  applicable", and delivered-but-unverified files were counted as "excluded by
  recommendation". Every surface now reads one `DeliveryIntegritySummary`.
- **A single residual cell shipped an entire raw file.** `フリガナ` (phonetic name) was not a
  recognized identifier, so one surviving name value failed the post-transform check and the
  whole table was delivered unmodified. Name readings are now a distinct identifier type, and
  when a transform cannot be fully verified the partially de-identified output is delivered
  instead of the original.
- **The same entity got different pseudonyms per file format.** A headed table matched
  `学籍番号` → `student-id`; a headerless one could only infer `account-id` and switched to
  column-index-keyed tokens, so headed and headerless exports of one dataset could not be
  joined. Identity is now resolved per run, independent of format, row order and column order.
- **A bare ISO date could be tokenized as a phone number.** `2026-07-15` is digits and
  hyphens and matched the phone pattern; temporal values are now excluded.
- **Estimated context reduction was clamped to 0%.** Pseudonymization can enlarge output, and
  `Math.max(0, …)` turned a real −23.1% into a headline "0%" while the same output printed
  −23.1% twelve lines later.
- **"Large files excluded" counted neither large nor excluded files.** Renamed to
  `largeArtifactsReduced`; the old JSON field is still emitted and is deprecated.
- **One document counted twice, and "running" forever.** Background accounting now reports
  source documents and inspection jobs separately, and is `idle` once every job is terminal.
- **A document whose companion never arrived was reported nowhere.** It is now counted as
  `contextUnavailable` and stated on the CLI and in the agent handoff.

### Added

- **Duplicate-content families.** Re-exports of one table (CSV/TXT/TSV, BOM/no-BOM, LF/CRLF)
  are grouped by identical bytes or by identical table content. One canonical representation
  is delivered; a redundant copy is replaced by a short alias naming it — but only when the
  alias is genuinely smaller, so a small table is never replaced by a larger stub. Duplicate,
  unique and canonical byte counts are reported separately.

### Notes

- Delivered bytes change in two cases: a partially de-identified output in place of a raw
  original, and a canonical alias in place of a redundant duplicate. Both are additive to
  safety; Safe Apply refuses to write either back over a source file.
- Absolute token figures remain estimates (`chars / 4`) and understate real counts.

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
  the official extension's own UI. Existing Claude Code authentication is supported;
  first-time sign-in in an isolated Yuhi environment has not yet been validated.
- Strict Mode masks detected secrets and supported identifiers; coverage depends on file
  format and content. It is not a guarantee that every secret or identifier is removed.
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
