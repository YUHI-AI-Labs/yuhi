# Phase 2b-2b: Repository Ready controls (Safety Mode / Context Detail / per-file include-exclude / apply-and-re-prepare)

## Summary

0.3.0 shipped the **Repository Ready** card and the read-only **"What the AI Can
See"** review. In that release, Safety Mode and Context Detail are **display-only
labels**, and file decisions are **not** editable. Phase 2b-2b makes the review
**actionable**: choose a Safety Mode, choose a Context Detail level, override
per-file Include / Exclude, and **apply and re-prepare** — without ever showing a
stale review as if it were current.

## Motivation

Today the review answers "what will the AI see?" but the user cannot change the
answer inside Yuhi. The gap: a user who wants stricter privacy, more or less
context, or a specific file kept in/out must edit `yuhi.yaml` and re-run. Phase
2b-2b closes that loop while preserving the highest-priority principle
(`CLAUDE.md`): reach Claude Code quickly with safe defaults, and let the user make
the final decision explicitly.

## Scope

- **Safety Mode selector** — **Balanced** / **Strict** / **Maximum Privacy**.
- **Context Detail selector** — **Full** / **Reduced** / **Minimal**.
- **Per-file Include / Exclude** — with **Reset to policy** to drop a manual
  override and return to the policy-derived decision.
- **Apply and re-prepare** — one action that re-runs preparation with the current
  Safety Mode, Context Detail, and per-file overrides.
- **Dirty-state handling** — while any change is pending (unapplied), the panel is
  in a **dirty** state: the previously shown report/decisions are marked stale and
  the Launch action is disabled until a fresh prepare succeeds.
- **Pre-launch final review** — a final confirmation that the review being launched
  from reflects the **most recent successful** prepare.

## Acceptance criteria

- [ ] **Any configuration change invalidates the previous review.** Changing the
  Safety Mode, changing the Context Detail, or changing a per-file decision MUST
  trigger a **re-prepare** and MUST **invalidate and hide** the previous Repository
  Ready report and the previous file decisions. The old review is **never shown as
  current**.
- [ ] **Launch is gated on a fresh prepare.** The Launch (open Claude Code) action
  is **enabled only after a fresh, successful prepare** that reflects the current
  configuration. In the dirty state (a change is pending or a re-prepare is
  running/failed), Launch is disabled.
- [ ] **Safety Mode selector** offers Balanced / Strict / Maximum Privacy and, on
  change, re-prepares and updates the report.
- [ ] **Context Detail selector** offers Full / Reduced / Minimal and, on change,
  re-prepares and updates the report.
- [ ] **Per-file Include / Exclude** applies as an override; **Reset to policy**
  removes the override and restores the policy-derived decision. Each such change
  re-prepares.
- [ ] **Reset to policy** across all overrides returns the run to the pure
  policy-derived state.
- [ ] **Apply and re-prepare** runs preparation with the current settings +
  overrides and, on success, replaces the report and decisions with the fresh
  result.
- [ ] **Dirty-state** is visible: the stale report/decisions are clearly marked and
  not presented as the launchable state.
- [ ] **Pre-launch final review** confirms the launch uses the most recent
  successful prepare.
- [ ] **Include-anyway safety is preserved** — a per-file Include of a high-risk
  file follows the existing explicit-override rules (concise risk explanation,
  confirm once per unchanged file, no raw fallback), consistent with `CLAUDE.md`.
- [ ] **The public report stays public-safe** — none of these controls introduce a
  filename, path, secret type, or identity into the copied/exported report.

## Out of scope (deferred)

- **Local AI (Ollama summaries)** enhancements.
- **Codex / Gemini adapters.**
- **GitHub Action enhancements** (the Action stays report-only).
- **OS-level sandbox.**

## Notes

- Consistent with `docs/THREAT_MODEL.md` and `CLAUDE.md`: a user override is never
  described as safe, verified, or confined merely because the agent starts in the
  Prepared Workspace; Yuhi is not an OS sandbox.
- Estimated reduction remains an estimate of agent-accessible content, not token or
  cost savings.
