# Yuhi 0.3.0 — post-release smoke test

Run this **after publishing** 0.3.0 (npm + Marketplace + the Action), to confirm
the live artifacts behave as documented. Every step lists an **action**, an
**expected result**, and a **public-safety check** (the shared report must never
contain a filename, path, secret value, or identity).

Use a **scratch repository** that intentionally contains a few secrets, a document
or two, and a table — not a real project.

```bash
mkdir -p /tmp/yuhi-030-smoke && cd /tmp/yuhi-030-smoke
git init -q
printf 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n' > .env
printf 'name,email\nAlice,alice@example.com\n' > people.csv
# add a small PDF/DOCX here too if available
```

## 1. npm CLI

### 1.1 Prepare from a scratch repo

- **Action:** `npx @yuhi-ai-labs/yuhi@0.3.0 prepare` in `/tmp/yuhi-030-smoke`.
- **Expected:** exits successfully and prints the **Repository Ready** block —
  Source files / Prepared artifacts / Documents prepared / Secrets blocked /
  Identifiers transformed and an **Estimated accessible-content reduction: N%**,
  ending in `Ready for Claude Code.` The `.env` is counted under **Secrets
  blocked**; the CSV identifiers under **Identifiers transformed**.
- **Public-safety:** the printed report shows only aggregate numbers — no
  filename, path, secret value, or email.

Capture the run id for the next step — `prepare --json` prints it as `runId`:

```bash
RUN=$(npx @yuhi-ai-labs/yuhi@0.3.0 prepare --json | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runId||""))')
echo "$RUN"
```

### 1.2 `yuhi report` in all four formats

- **Action:** run each format:

  ```bash
  npx @yuhi-ai-labs/yuhi@0.3.0 report "$RUN" --format terminal
  npx @yuhi-ai-labs/yuhi@0.3.0 report "$RUN" --format markdown
  npx @yuhi-ai-labs/yuhi@0.3.0 report "$RUN" --format json
  npx @yuhi-ai-labs/yuhi@0.3.0 report "$RUN" --format svg
  ```

- **Expected:**
  - **terminal** — the Repository Ready block.
  - **markdown** — a `## Repository Ready` table plus the estimate note.
  - **json** — parseable object with `sourceFiles`, `preparedArtifacts`,
    `documentsPrepared`, `secretsBlocked`, `identifiersTransformed`,
    `estimatedReductionPercent`, `status`.
  - **svg** — a self-contained "Prepared with Yuhi — N% reduced" badge.
- **Public-safety:** grep each output — nothing leaks:

  ```bash
  npx @yuhi-ai-labs/yuhi@0.3.0 report "$RUN" --format json | \
    grep -Ei 'AKIA|@example\.com|/tmp/|\.env|people\.csv' && echo "LEAK" || echo "clean"
  ```

  Expected: `clean` for all four formats.

## 2. VS Code extension

### 2.1 Install the 0.3.0 VSIX

- **Action:** install into a clean profile:

  ```bash
  TMP=$(mktemp -d)
  code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" \
    --install-extension yuhi-vscode-0.3.0.vsix
  code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" /tmp/yuhi-030-smoke
  ```

- **Expected:** the extension installs and activates; displayName shows **"Yuhi —
  AI-Ready Repositories"**. The status bar shows a Yuhi state.

### 2.2 Prepare → Repository Ready card

- **Action:** run **Yuhi: Prepare Workspace** (or **Prepare with Yuhi** from the
  Explorer).
- **Expected:** preparation completes and the review panel shows the **Repository
  Ready** card with the same outcomes and the estimated reduction.
- **Public-safety:** the card shows aggregate numbers only.

### 2.3 Copy / Export

- **Action:** click **Copy public report**, then **Export…** and save each of
  **Markdown**, **JSON**, and the **SVG badge**.
- **Expected:** the clipboard holds the Markdown report; three files are written.
- **Public-safety:** inspect the copied/exported content — no filename, path,
  secret value, or email; only aggregate numbers.

### 2.4 What the AI Can See

- **Action:** open the **What the AI Can See** review below the card.
- **Expected:** **Available to the AI** vs **Unavailable to the AI**, with the
  buckets (prepared/transformed, included unchanged, excluded by user, excluded by
  policy, kept local because verification failed). The `.env` appears under a
  withheld/kept-local bucket; the CSV under prepared/transformed with an
  Original ↔ Prepared diff. Safety Mode and Context Detail appear as
  **display-only labels** (not selectable in 0.3.0). The filter narrows the list.
- **Public-safety:** file paths shown here are review-only — confirm they are
  **not** present in the report copied/exported in 2.3.

## 3. GitHub Action (report-only)

Add the report workflow to the scratch repo (or a test repo on GitHub):

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

- **Action:** trigger the workflow (push / `workflow_dispatch`).
- **Expected:**
  - A **"Yuhi Repository Report"** appears in the run's **Job Summary** (the
    Markdown table).
  - A **`yuhi-report`** artifact containing `yuhi-report.json` is uploaded.
  - The **build is not failed** — the step exits successfully even though the repo
    contains a secret (report-only, `fail-on-error` defaults to `false`).
  - No PR comment is posted.
- **Public-safety:** open the Job Summary and download the JSON artifact — confirm
  only aggregate numbers; no filename, path, secret value, or email in the summary,
  the artifact, or the logs.

## Sign-off

- [ ] npm: prepare → Repository Ready → all four report formats, all public-safe.
- [ ] VS Code: install → prepare → card → Copy/Export → What the AI Can See.
- [ ] Action: report in Job Summary, JSON artifact uploaded, build not failed, no
  PR comment.
- [ ] No leak found in any shared report (path / secret / email / high-entropy).
