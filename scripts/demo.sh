#!/usr/bin/env bash
# Drives Yuhi through its 30-second story on the demo project.
# Use directly, or record it into a GIF (see docs/DEMO.md).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export YUHI_HOME="${YUHI_HOME:-$(mktemp -d)/yuhi-demo}"
yuhi() { node "$ROOT/apps/cli/dist/index.js" -C "$ROOT/examples/demo" "$@"; }

step() { printf '\n\033[36m$ yuhi %s\033[0m\n' "$*"; sleep "${PAUSE:-1.2}"; yuhi "$@"; sleep "${PAUSE:-1.2}"; }

clear 2>/dev/null || true
printf '\033[1mYuhi — see exactly what your AI knows.\033[0m\n'
step status          # the AI context at a glance — 98% smaller
step preview         # exactly which files Claude will and will not see
step run dummy       # launch the agent inside the safe context (dummy = offline)
printf '\n\033[32m✓ Claude ran on a clean, 98%%-smaller context. Your repo was never modified.\033[0m\n'
