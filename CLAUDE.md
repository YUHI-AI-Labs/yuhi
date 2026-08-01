# Yuhi Project Memory

This file records durable product-development principles for Yuhi. Read it before
planning or implementing product behavior. Security claims must also remain
consistent with `docs/THREAT_MODEL.md`.

## Highest-priority product principle

> Yuhiの成功指標は、すべてのファイルを完全に検査することではなく、安全なデフォルトを保ちながら、ユーザーを最短でYuhi ModeのClaude Codeへ到達させることである。

Yuhi is a Preparation Layer that gets the user into Claude Code in Yuhi Mode as
quickly as possible. Security matters, but an individual risky, excluded, or
unverified file must not stop the entire workspace from launching when Yuhi can
create and verify a usable Prepared Workspace.

The decision model is:

```text
Yuhi evaluates risk
        ↓
Yuhi recommends an action
        ↓
The user makes the final decision
```

The current product principle is:

```text
Start Yuhi Mode first.
Make useful context available.
Disclose uncertainty honestly.
Improve it in the background.
Let the user decide.
```

### Default file behavior

- **Safe**: include automatically.
- **Caution / Unverified (Balanced)**: include the useful original with an explicit
  `inspection-pending` warning, register background processing, and continue launching
  Yuhi Mode. Never label it verified.
- **Caution / Unverified (Strict)**: include ordinary documents with an explicit
  warning and continue background inspection. Known credentials and private keys stay
  blocked. Do not turn Strict into Maximum Privacy.
- **Caution / Unverified (Maximum Privacy)**: keep the original local and publish only
  a verified companion.
- **High risk**: exclude by recommendation, but continue launching. Let the user
  explicitly choose `Include anyway`, `Keep excluded`, or, when supported,
  `Use transformed copy`.

The unverified-file invariant is:

```text
inspection unavailable or unsuccessful
  → Balanced: include with warning when no known credential/policy block exists
  → Strict: include ordinary documents with warning; block known credentials
  → Maximum Privacy: keep original local
  → process safely in background
  → never delay Yuhi Mode for optional heavy inspection
```

Only an actual high-risk finding, user exclusion, or explicit policy rule counts as
excluded. Inspection pending, warning availability, background processing, and
processing failure are distinct states. UI and handoff report them separately using
public-safe counts only.

The governing invariant is:

```text
file blocked ≠ launch blocked
```

The default high-risk notification should be calm and non-blocking:

> 1 sensitive file was excluded for your protection.  
> You can review or include it later.

Raw unsafe content must never be included accidentally or as an implicit fallback.
`Include anyway` is a deliberate user override: show a concise risk explanation,
confirm once per unchanged file within the session, and do not ask repeatedly.
Associate the decision with a content fingerprint when possible; changed content
must be evaluated again.

A global setting **Default handling for high-risk files** controls the default:
`Exclude and continue` (recommended) · `Ask before launch` · `Include with warning`.
The recommended default preserves safety without interrupting the workflow. The
review surface offers a primary `Continue to Claude Code` (recommended settings)
action plus an optional `Review file decisions` list; each row exposes the
`Include anyway` / `Keep excluded` / `Use transformed copy` actions above.

### Standard flow

```text
Prepare
  → place available safe or safely transformed files in the Prepared Workspace
  → exclude high-risk files by recommendation
  → open Claude Code in Yuhi Mode
  → report exclusions and warnings without blocking the workflow
```

When the user already chose to start Claude Code, successful preparation should
transition directly into Yuhi Mode. Do not hold the user on a confirmation screen
or require a second Start action.

### Workspace-level launch blockers

Launching may be blocked only for a workspace-level failure such as:

- the Prepared Workspace cannot be created;
- output integrity cannot be verified;
- no valid workspace can be opened;
- internal consistency verification fails; or
- required sandbox-policy installation or verification fails.

A file-level risk, unsupported inspection, background document task, omission, or
warning is not by itself a workspace-level launch failure.

### Primary UX states

The primary UI must always make one of these states clear:

- `Preparing`
- `Opening Claude Code`
- `Yuhi Mode ready`
- `Failed to open`

PDF inspection, OCR, summarization, detailed metrics, unverified-file processing,
and excluded-file review normally continue in the background and must not delay
entry into Claude Code.

### Estimated context reduction is a primary outcome

Every successful Prepare and Review surface must show **Estimated context
reduction** prominently in the primary summary, using a large, immediately visible
value rather than hiding it in technical or advanced details. It must be visually
secondary only to the current workflow state and primary action.

Calculate it consistently as:

```text
(beforeTokens - afterTokens) / beforeTokens * 100
```

When `beforeTokens` is zero, report `0.0%`. Always label the value exactly
`Estimated context reduction`. Never describe it as actual token usage, API token
savings, billing savings, cost savings, or a provider measurement. Explain that
actual agent usage may differ because of system prompts, tool output, conversation
history, and caching.

After entry, the sidebar should communicate the active boundary and useful status,
for example:

```text
YUHI MODE

✓ Claude Code is using the Prepared Workspace
✓ 11 files available
⚠ 1 file excluded by recommendation
⟳ 1 document processing in the background

[Review file decisions]
```

Do not imply filesystem confinement or guaranteed safety. Yuhi prepares initial
context; external-path access can remain possible when the runtime or user permits
it.

### Implementation priority

When requirements compete, prefer this order:

1. Reach Claude Code in Yuhi Mode quickly.
2. Apply safe default handling to risky files.
3. Let the user override the final file decision explicitly.
4. Complete inspection, summarization, and metrics in the background.

Avoid implementations that stop the entire flow for one excludable file, wait for
optional inspection before opening Claude Code, or trap the user on an internal
state or confirmation screen after a valid Prepared Workspace is ready.

### Agent capability and context efficiency

Yuhi controls repository preparation and Safe Apply, not Claude Code's general
permission model. Standard, Plan, Accept Edits, Auto, and Custom permission modes
remain user choices. Standard and Guarded sandbox presets must not inject
`disableAutoMode` or globally force bypass permissions off. Only the explicitly
selected Locked Down preset may impose those restrictions.

Context Compression defaults to `Auto (Recommended)` with **no Token Budget target**
(blank / `No target`). `Auto` and `On` accept an optional Token Budget: a positive
value is a best-effort target; blank / `0` means no target; `Off` retains the saved
value but does not apply it. The unset-workspace default is therefore Safety Mode
`Balanced`, Compression `On`, Token Budget `No target` — Maximum Privacy applies only
when the user explicitly selects it. Compression and parser failures always fall back
to the FULL original. A token target must never delete a useful repository file.
Compact representations are additive companions; the original remains available.

All public surfaces use the Core `YuhiModeSummary`. It deduplicates each source file
across Preparation and Background and separates repository-representation estimates
from the initial agent-context estimate. Never present repository totals as actual
provider usage or billing savings.

## Known conflicts requiring an explicit design update

Do not silently reinterpret these conflicts:

1. `docs/THREAT_MODEL.md` currently describes path-rule `block` as the primary
   boundary for secret files. The new product principle requires a separately
   designed, explicit `Include anyway` override while still prohibiting accidental
   raw fallback. Update the threat model and tests together when that override is
   implemented.
2. Existing tests and UI paths may treat `Partial`, transformation failure, or a
   high-risk file as a launch blocker. Preserve blocking only when the Prepared
   Workspace itself is invalid or unverified; otherwise represent omitted files as
   a launchable warning.
3. Yuhi is not an OS-level filesystem jail. A user override must never be described
   as safe, verified, or confined merely because the agent starts in the Prepared
   Workspace.
4. Current surfaces may conflate background-pending, processing failure, unsupported,
   and excluded-for-safety. Apply the Safety Mode-specific routing above, and keep manifests,
   manifests, Review UI, handoff wording, and regression tests so those states remain
   distinct and do not block Yuhi Mode.
