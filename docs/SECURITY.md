# Security Policy

Yuhi is a security-focused tool, so we take the security of Yuhi itself
seriously. This document explains how to report vulnerabilities, what versions
are supported, and — importantly — what Yuhi does and does not protect against.

## Please read first: what Yuhi is and isn't

Yuhi is **defense-in-depth, not a sandbox**.

Yuhi scans a repository, applies a `yuhi.yaml` policy to block or redact
secrets and sensitive paths, copies the *allowed* files into a generated
workspace under `~/.yuhi/workspaces/<id>` (without modifying your original
repo), and launches an AI coding agent there.

That reduces what an agent is handed by default. It does **not**:

- Sandbox the agent's process at the OS level.
- Prevent the agent from making network requests.
- Prevent a determined or malfunctioning agent from reading files outside the
  workspace if it explicitly tries to.
- Guarantee that no sensitive data ever reaches a model.

Please do not describe Yuhi as "completely safe", "100% secure", or a guarantee
against data leakage. It is one layer that raises the floor, not a boundary you
can fully trust.

A **detection gap** (a secret or sensitive path that Yuhi failed to block or
redact and then copied into the workspace) *is* an in-scope security issue — see
below.

## Reporting a Vulnerability

**Please report vulnerabilities privately. Do not open a public issue for a
security problem.**

Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** ("Report a vulnerability" under Security
   Advisories).
3. Provide as much detail as you can (see below).

This opens a private GitHub Security Advisory visible only to you and the
maintainers.

### What to include

- A clear description of the issue and its impact.
- Steps to reproduce, ideally with a minimal `yuhi.yaml` and a sanitized sample
  repo or fixture. **Do not include real secrets** — use obviously fake values.
- Affected version(s) / commit.
- Your environment (OS, Node.js version).
- Any suggested remediation, if you have one.

## Supported Versions

Yuhi is pre-1.0 and moves quickly. Only the latest released `0.x` version
receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| latest `0.x` | :white_check_mark: |
| older `0.x`  | :x:                |

Once Yuhi reaches 1.0, this table will be updated with a longer support policy.

## Response Expectations

We are an early-stage, small-maintainer project, so please set expectations
accordingly. We aim to:

- **Acknowledge** your report within **5 business days**.
- Provide an **initial assessment** (in scope / not in scope, severity) within
  **10 business days**.
- Keep you updated on remediation progress and coordinate a disclosure timeline
  with you.

These are targets, not contractual guarantees.

## Scope

**In scope** (please report):

- Detection gaps: a secret or sensitive file that a default/documented policy
  should have blocked or redacted but that Yuhi copied into the workspace.
- Path-traversal, symlink-escape, or similar issues that cause Yuhi to read or
  copy files outside the intended set.
- Policy-engine correctness bugs that cause allow/deny/redact to be evaluated
  incorrectly in a way that leaks data.
- Injection or code-execution issues in Yuhi's own CLI, extension, or config
  parsing.
- Audit-log tampering or omissions that misrepresent what an agent was given.
- Insecure defaults in Yuhi's own behavior.

**Out of scope** (generally not a Yuhi vulnerability):

- The fact that a launched agent has network access or can attempt to read
  outside the workspace — this is a documented limitation, not a bug.
- Vulnerabilities in third-party agents (Claude Code, Codex CLI, Gemini CLI) or
  in the models themselves.
- A user's own policy being too permissive (misconfiguration). We'll still
  gladly take reports where safer defaults would have helped.
- Social-engineering, physical access, or issues requiring a fully compromised
  local machine.
- Findings from automated scanners with no demonstrated impact.

If you're unsure whether something is in scope, report it privately anyway and
we'll help triage.

## Coordinated Disclosure

We practice coordinated disclosure. Please give us a reasonable opportunity to
investigate and ship a fix before any public discussion. We will credit
reporters who wish to be credited in the advisory and the changelog. We will not
take legal action against good-faith security research that respects this policy
and does not access or exfiltrate data beyond what is necessary to demonstrate
the issue.

Thank you for helping keep Yuhi and its users safe.
