# Yuhi Repository Report — GitHub Action (report-only)

A minimal, **report-only** GitHub Action that surfaces the public-safe
**Yuhi Repository Report** in your CI. Every run writes Yuhi's aggregate
numbers to the workflow's **Job Summary** and uploads them as a JSON artifact.

```yaml
- uses: YUHI-AI-Labs/yuhi-action@v0
  with:
    mode: report
```

## What it does

1. Runs `yuhi prepare` on your repository (via `npx @yuhi-ai-labs/yuhi@latest`).
2. Writes a **"Yuhi Repository Report"** to `$GITHUB_STEP_SUMMARY` using
   `yuhi report <run> --format markdown`.
3. Uploads `yuhi-report.json` (from `yuhi report <run> --format json`) as an
   artifact named `yuhi-report`.

## Report-only by design (v0)

This action is intentionally **not** a PR-blocking security gate:

- **Never fails the build by default.** If preparation reports a warning and
  `fail-on-error` is `false` (the default), the action writes a short note to
  the summary and exits successfully.
- **Never posts PR comments.**
- **Needs no write permissions.** `permissions: contents: read` is enough.

## Public-safe by construction

The report contains **aggregate numbers only** — for example `sourceFiles`,
`preparedArtifacts`, `documentsPrepared`, `secretsBlocked`,
`identifiersTransformed`, `estimatedReductionPercent`, and `status`. No
filenames, paths, or identities ever appear in the report, the summary, or the
logs.

## Inputs

| Input           | Default    | Description                                                                                     |
| --------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `path`          | `.`        | Repository directory to prepare.                                                                |
| `mode`          | `report`   | Action mode. Only `report` is supported in v0 (name reserved for future modes).                 |
| `fail-on-error` | `false`    | When `false`, a preparation warning is reported but never fails the job. `true` fails the step. |

## Usage

See [`.github/workflows/yuhi-report.example.yml`](../../.github/workflows/yuhi-report.example.yml)
for a full example on `pull_request` + `workflow_dispatch` with read-only
permissions.

```yaml
permissions:
  contents: read

jobs:
  yuhi-report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: YUHI-AI-Labs/yuhi-action@v0
        with:
          mode: report
```

## Location

This action currently lives in the Yuhi monorepo at
[`actions/yuhi-report`](.). A standalone **`YUHI-AI-Labs/yuhi-action`**
repository will mirror it so consumers can reference `YUHI-AI-Labs/yuhi-action@v0`
directly.

---

Powered by [Yuhi](https://github.com/YUHI-AI-Labs/yuhi) — an AI Context Runtime.
Apache-2.0 · YUHI-AI-Labs.
