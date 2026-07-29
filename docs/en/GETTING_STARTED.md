# Getting Started with Yuhi (5-minute quickstart)

Yuhi gives you a policy-controlled workspace for AI coding agents. It scans your
repository, blocks or redacts secrets and sensitive paths according to a
`yuhi.yaml` policy, copies the **allowed** files into a generated workspace
under `~/.yuhi/workspaces/<id>` **without modifying your original repo**, and
launches an agent there.

> **Honest scope:** Yuhi is *defense-in-depth, not a sandbox*. The launched
> agent still has network access and can attempt to read files outside the
> workspace if it tries. Yuhi reduces what the agent is handed by default; it
> does not guarantee that no data can ever leak. See
> [SECURITY.md](../../SECURITY.md).

## Prerequisites

- **Node.js 20+**
- A repository you want to work in
- An AI coding agent installed if you want to launch one (this quickstart uses
  the built-in **dummy** adapter first, so you can try Yuhi with no agent at
  all)

## 1. Install

> Yuhi is pre-release. Until it's published to npm, install from source (see
> [CONTRIBUTING.md](../../CONTRIBUTING.md)). Once published, installation will
> look like this:

```bash
# Global install (published name may be @yuhi-ai/cli — check the README)
npm install -g @yuhi-ai-labs/yuhi

# Or run without installing
npx @yuhi-ai-labs/yuhi --help
```

Verify:

```bash
yuhi --version
yuhi --help
```

## 2. Initialize a policy — `yuhi init`

From the root of the repository you want to protect:

```bash
cd path/to/your/repo
yuhi init
```

This creates a `yuhi.yaml` in your repo with sensible defaults: common secret
files (`.env`, credential files, key material) and sensitive paths are denied by
default, and built-in secret detectors are enabled. Open `yuhi.yaml` and adjust
the allow/deny/redact rules to fit your project.

A minimal policy looks roughly like this:

```yaml
# yuhi.yaml
version: 1
# Files matching these globs are never copied into the workspace.
deny:
  - "**/.env*"
  - "**/*.pem"
  - "**/id_rsa*"
  - "**/secrets/**"
# Matches here are copied but with detected secrets redacted.
redact:
  - "**/*.md"
# Everything else that isn't denied is allowed by default.
```

Rule precedence and the full schema are documented alongside the policy engine.

## 3. See what an agent would get — `yuhi scan` and `yuhi preview`

Before materializing anything, inspect the decisions.

```bash
# Scan the repo and report findings (what would be blocked/redacted).
yuhi scan

# Show the resolved allow / deny / redact decision for each path.
yuhi preview
```

`yuhi preview` is the heart of Yuhi's promise — **"See exactly what your AI
agent can see."** Review it and tighten `yuhi.yaml` until you're comfortable
with what would be exposed. If a secret shows up as *allowed*, fix your policy
(and please consider reporting a detection gap per
[SECURITY.md](../../SECURITY.md)).

## 4. Try it with the dummy agent (no real agent needed)

You can exercise the whole flow safely with the built-in **dummy** adapter,
which only prints the command it *would* run:

```bash
yuhi run dummy
```

This materializes the filtered workspace under `~/.yuhi/workspaces/<id>` and
shows what launching an agent there would do — without invoking anything real
and without touching your original repository.

## 5. Launch a real agent — `yuhi run claude`

When you're ready and have Claude Code installed:

```bash
yuhi run claude
```

Yuhi will:

1. Scan the repo and apply your `yuhi.yaml` policy.
2. Copy the allowed (and redacted) files into a fresh workspace under
   `~/.yuhi/workspaces/<id>`.
3. Launch Claude Code with that workspace as its working directory.
4. Write an **audit log** recording what was scanned and what the agent was
   given.

> Status: the **dummy** adapter is Stable; the **Claude Code** adapter is
> Experimental. Codex CLI and Gemini CLI adapters are Planned / not yet
> implemented.

## What Yuhi does NOT do

- It does not sandbox the agent process at the OS level.
- It does not block the agent's network access.
- It does not stop a determined or misbehaving agent from reading outside the
  workspace.
- It does not send telemetry — Yuhi has **no telemetry by default**.

## Where to go next

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — set up from source, add adapters and
  detectors.
- [SECURITY.md](../../SECURITY.md) — scope, limitations, and how to report issues.
- [GitHub Discussions](../../.github/DISCUSSIONS.md) — questions and ideas.
