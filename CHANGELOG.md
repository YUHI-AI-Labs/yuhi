# Changelog

## 0.4.8 — Privacy Mode + Measurement Reliability

**Privacy Mode** (Balanced / Strict / Trusted Local) is now the single, user-facing
selector for direct-personal-identifier handling, shared by Static Prepare, Dynamic
Terminal Mode, and Native GUI Mode — a DIFFERENT axis from Safety Mode, which governs
how much unverified content is withheld. Balanced and Strict apply an identical
identifier transform (they differ only in whether unverified artifacts stay
local-only); Trusted Local disables the transform entirely and requires explicit
acknowledgement (`--acknowledge-unmasked-data` on the CLI, a confirmation prompt in VS
Code) before it can be selected — it is never a silent default or fallback.

- **Static Prepare**: `yuhi prepare --privacy-mode <mode>`, precedence CLI flag >
  `yuhi.yaml`'s new `privacy.mode` > Balanced. Secret redaction remains unconditional
  in every mode, exactly as before — Privacy Mode never weakens it.
- **Dynamic Terminal / Native GUI**: real, live direct-personal-identifier
  transformation is now applied to tool results flowing through the gateway (this did
  not exist before — only secret handling did). Routed by content shape (tabular/JSON/
  prose/source/config) so source code and command output are not scanned for
  CJK name-shaped substrings the way document prose is. A prepared workspace's own
  recorded mode is inherited by a plain `yuhi launch claude --dynamic-context`, and an
  explicit mode conflicting with a Trusted-Local-prepared run is refused rather than
  silently reused.
- **VS Code**: `yuhi.privacyMode` setting, plus a one-time first-run picker
  ("Prepare → Privacy Mode → Start Claude Code") so a new user chooses explicitly
  instead of silently defaulting.
- **Secret delivery is a separate, composed axis from Privacy Mode**, and its contract
  differs by surface: Static Prepare redacts every detected secret unconditionally, in
  every Privacy Mode. Dynamic Terminal and Native GUI Mode default to Developer Mode
  (project configuration, including `.env`, may reach Claude Code) with a Strict
  delivery option that masks detected secrets before they leave. Raw secret values are
  never written to Yuhi's own logs, evidence, statistics, or UI, in any mode.
- **Dynamic Context now transforms direct personal identifiers**, not only secrets —
  tool output, JSON, command output, and retrieved context flowing through the gateway
  are routed by content shape (tabular/JSON/prose/source/config) and masked per the
  active Privacy Mode. A masked value (e.g. `PERSON-001`) is stable through compression
  and a later retrieval of an omitted range: **retrieval re-applies the same privacy
  policy on every fetch, never a raw fallback.**
- **JSON masking is intentionally narrower than "every personal field"**: a JSON
  object's `name`-shaped field is masked by key only when the SAME object also carries a
  recognized operational key (e.g. `student_id`, `course_code`) — a deliberate
  precision trade-off against over-masking ordinary API/fixture JSON. Shape-detectable
  values (email, phone, and similar) are always masked regardless of key. **"All JSON
  personal identifiers are transformed" is not an accurate claim about this release.**
  See `docs/design/0.4.8_privacy_mode.md`'s Known limitations.
- **Fixed**: Static Prepare's final-artifact security gate reported Trusted Local's
  correct, intentional raw-preservation of a tabular direct-identifier file as a failed
  verification (`postTransformScan: "failed"`, `failureCategory: "reidentification-risk"`).
  Trusted Local now reports `postTransformScan: "not-applicable"` with an accurate
  "intentionally left unmasked" reason; Balanced/Strict verification behavior is
  unchanged.
- Token measurement now reports exact byte and code-point counts alongside the
  estimate, and exposes which estimation method (heuristic or exact tokenizer) produced
  a given figure — see Measurement Reliability below.
- Removed numeric benchmark claims (e.g. "94% reduced") from the README (all
  languages), the VS Code extension README, and the marketing site. Context reduction
  is repository-, task-, and model-dependent; numeric results will be regenerated for
  v0.5 rather than restated as a fixed figure.

**Measurement Reliability**: token estimation now weights CJK text separately from
Latin script (mainstream tokenizers split CJK far denser than the old flat
chars/4 heuristic assumed — a real accuracy fix for this product's own primary use
case, Japanese student records). Fixed `setTokenEstimator` silently doing nothing for
Dynamic Context, and a `yuhi status` reduction figure that violated the project's own
"never clamp a reduction" rule. `yuhi prepare`'s normal output is now a short, ~8-line
summary; `--verbose` preserves the full previous report.

See `docs/design/0.4.8_privacy_mode.md`, `docs/design/0.4.8_measurement_reliability.md`,
and `docs/design/0.4.8_first_run_ux.md` for full design decisions, what was
deliberately deferred, and a claims audit of existing token/cost figures in this
README and the site.

## 0.4.7 — Document/PDF privacy pipeline

**Document companions (PDF/DOCX/PPTX) now go through the SAME de-identification
taxonomy, registry and independent verification as tabular data.** Previously, a
document companion's pseudonymizer only understood delimited tables; extracted prose
threw, the catch silently returned an empty forbidden list, and the companion
published completely unmasked while labelled "Verified" — issue #21, now fixed.

- A personal name backed by a matching business key (student id, employee id, …)
  present in the SAME document reuses the exact token a table in the same run already
  minted for that person (`PERSON-001` everywhere). A name with no such key mints its
  own token instead of merging onto an unrelated entity — two different people sharing
  a name must never collapse onto one token.
- Every direct identifier and CJK name-shaped candidate the detector recognizes is
  masked; nothing is left raw because it could not be linked. Operational identifiers
  (student id, course code, …) are preserved, exactly as in CSV/XLSX.
- Independent, structurally-separate verification runs before publish — a bug in the
  masking pass is not trusted to have caught itself.
- Known limitation: name detection covers 2–4 character CJK sequences only. A
  single-character, 5+ character, or non-CJK (Latin-script) personal name is not
  detected. See `docs/design/0.4.7_document_privacy.md` for the full policy and the
  permitted/prohibited claims about this feature.

## 0.4.6 — Privacy taxonomy: protect people, preserve keys

**Yuhi no longer tries to remove every identifier.** It protects what identifies a
*person* and preserves the keys an analysis needs. Masking a student number or a course
code destroyed the joins and group-bys the data existed for while buying no privacy —
the person is already protected once their name is gone.

Every identifier now falls into one of three categories:

```text
DIRECT PERSONAL   name, name-reading, email, phone, address, MyNumber,
                  passport, bank account, credit card, biometric, government id
                  → pseudonymized

OPERATIONAL       student id, student card, employee id, account id, institutional id,
                  course code, staff id, application number, record id
                  → preserved

ANALYTICAL        grade, score, evaluation, department, year, term, attendance, …
                  → preserved
```

### Token vocabulary

Tokens name the *kind* of identifier, not a role, because a role is unstable in prose
(担当者 / 申請者 / 受験者 all appear for the same column):

```text
PERSON-001  READING-001  EMAIL-001  PHONE-001  ADDRESS-001  BANK-001  GOVID-001
```

An address keeps its locality and loses everything below it, so regional analysis still
works while the household does not:

```text
京都府京都市左京区吉田本町123-4  →  京都府京都市 ADDRESS-001
```

### One person, one token, every format

The run registry resolves identity from the *preserved* operational keys, so the same
person carries the same token across CSV, TSV, TXT and XLSX in a run. A key is only used
for identity resolution when it actually discriminates: a course code, a staff id and a
constant term/cohort column are excluded, because using them merges every row of a class
onto one entity.

### Verification

Verification is scoped to direct-personal columns. A preserved operational identifier is
compliant output, not residue — four separate gates were counting it as a leak and
delivering correctly prepared files as `included-unverified`.

### Fixed

- Cross-format tokens diverged: the same person received `PERSON-001` in a CSV and
  `PERSON-003` in an XLSX, because filtering to direct-personal identifiers ran *before*
  identity resolution and removed the linkage keys.
- A constant operational column (a term or cohort code) collapsed every person in a
  730-row export onto a single token.
- Headerless files stopped protecting names: with no header, inference could only return
  an operational type. Classification now falls back to value *shape*, which also fixes
  single-row files where every column is trivially unique.
- The safety-check, the final artifact gate, the XLSX forbidden-value set and the
  structured rescan all treated preserved keys as residue.

### Not in this release

The document/PDF path still uses its own pipeline; `text-deidentify.ts` is written but
not yet wired. That is 0.4.7, and it will reuse this taxonomy, this registry and this
verification rather than introducing PDF-specific rules.

## 0.4.5 — new Marketplace display name

**The VS Code extension display name is now `Yuhi Code — See What Your AI Agent Sees`.**
No behaviour changes.

The removed listing reserved its display name as well as its id, so 0.4.4's display name
was rejected on upload for the same reason its predecessor's id was. This release changes
the display name so the extension can be published.

`v0.4.4` was published to **npm only** — its VSIX was never accepted by the Marketplace,
because the display name was rejected. `@yuhi-ai-labs/yuhi@0.4.4` is therefore a valid CLI
release; only the extension side of 0.4.4 does not exist. 0.4.5 supersedes it on both.

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

`v0.4.4` was published to **npm only**; its VSIX was never accepted by the Marketplace,
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
