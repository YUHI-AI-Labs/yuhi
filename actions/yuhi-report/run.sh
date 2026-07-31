#!/usr/bin/env sh
#
# Yuhi Repository Report — composite action runner (report-only, v0).
#
# Prepares the given repository directory with Yuhi, then renders the
# PUBLIC-SAFE preparation report (aggregate numbers only — never filenames,
# paths, or identities) into the GitHub Actions Job Summary and a JSON
# artifact.
#
# This script deliberately never echoes the prepared workspace path or any
# source content. Only `yuhi report` output is surfaced.
#
# Inputs (via environment):
#   INPUT_PATH          repository dir to prepare (default ".")
#   INPUT_MODE          only "report" is supported in v0
#   INPUT_FAIL_ON_ERROR "true" | "false" — when false, never fail the job
#   GITHUB_STEP_SUMMARY path to the job summary file (provided by the runner)
#
set -eu

YUHI_PKG="@yuhi-ai-labs/yuhi@latest"
REPORT_JSON="yuhi-report.json"

REPO_PATH="${INPUT_PATH:-.}"
MODE="${INPUT_MODE:-report}"
FAIL_ON_ERROR="${INPUT_FAIL_ON_ERROR:-false}"

summary() {
  # Append to the Job Summary if available, otherwise stdout.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$1"
  fi
}

# v0 reserves the `mode` name but only implements `report`.
if [ "$MODE" != "report" ]; then
  summary "### Yuhi Repository Report"
  summary ""
  summary "Unsupported mode \`$MODE\`. Only \`report\` is supported in v0."
  if [ "$FAIL_ON_ERROR" = "true" ]; then
    exit 1
  fi
  exit 0
fi

# 1) Prepare the workspace and capture the machine-readable result.
#    We intentionally do NOT print PREPARE_OUT to the logs — it can contain
#    workspace paths. Only the run id is extracted from it.
set +e
PREPARE_OUT="$(npx --yes "$YUHI_PKG" prepare "$REPO_PATH" --json 2>/dev/null)"
PREPARE_STATUS=$?
set -e

if [ "$PREPARE_STATUS" -ne 0 ] || [ -z "$PREPARE_OUT" ]; then
  summary "### Yuhi Repository Report"
  summary ""
  summary "Yuhi preparation reported a warning, so no report could be generated for this run."
  summary ""
  summary "_Report-only action: the build was not failed._"
  if [ "$FAIL_ON_ERROR" = "true" ]; then
    exit 1
  fi
  exit 0
fi

# 2) Extract the runId from the JSON using node (always present on runners).
RUN_ID="$(
  printf '%s' "$PREPARE_OUT" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const id = data && typeof data.runId === "string" ? data.runId : "";
        process.stdout.write(id);
      } catch {
        process.stdout.write("");
      }
    });
  '
)"

if [ -z "$RUN_ID" ]; then
  summary "### Yuhi Repository Report"
  summary ""
  summary "Yuhi prepared the workspace but no run id was returned, so no report could be generated."
  summary ""
  summary "_Report-only action: the build was not failed._"
  if [ "$FAIL_ON_ERROR" = "true" ]; then
    exit 1
  fi
  exit 0
fi

# 3) Render the public-safe markdown report into the Job Summary.
summary "### Yuhi Repository Report"
summary ""
npx --yes "$YUHI_PKG" report "$RUN_ID" --format markdown >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
summary ""
summary "_Report-only: aggregate numbers only, no filenames or paths. Powered by [Yuhi](https://github.com/YUHI-AI-Labs/yuhi)._"

# 4) Save the public-safe JSON report as an artifact.
npx --yes "$YUHI_PKG" report "$RUN_ID" --format json > "$REPORT_JSON"

exit 0
