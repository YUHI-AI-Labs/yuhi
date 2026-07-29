# Yuhi VS Code beta — real-device acceptance

Run these on a machine with **Ollama installed**. Target: **under 10 minutes**.
Everything is local; preparation talks only to `http://127.0.0.1:11434`.

Fixture: [`examples/acceptance-fixture/`](../../examples/acceptance-fixture/) — fake data
only (`students.csv`, `notes.md/.txt`, `data.json`, `src/app.ts`, a kept-local
`private/customer-notes.txt`, and `logo.bin` to prove binaries are skipped). **No
token-shaped strings are committed.** The keep-local secret check below generates a
throwaway `.env` at runtime and deletes it afterward.

---

## 0. Build the CLI from source (no npm needed)

```bash
cd ~/Documents/yuhi
pnpm install && pnpm build
YUHI="node $(pwd)/apps/cli/dist/index.js"   # the `yuhi` binary
```

## 1–3. Ollama + model

```bash
command -v ollama || echo "Install Ollama: https://ollama.com/download"   # (1) installed
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null && echo "Ollama API OK"  # (2) API responds
ollama pull qwen3:1.7b                                                     # (3) model (~1.4 GB)
```

## 4. `yuhi doctor` reports Ready

```bash
cd ~/Documents/yuhi/examples/acceptance-fixture
$YUHI doctor
# Expect: Ollama installed ✓, running ✓, model qwen3:1.7b installed ✓, .yuhi writable ✓ → Ready
```

## 5–8. Prepare + inspect (originals unchanged, reduction shown)

```bash
# Generate a THROWAWAY token-shaped secret at runtime (never committed) to prove
# keep-local. It is deleted at the end of this section.
printf 'API_KEY=sk-%s\n' "$(openssl rand -hex 20)" > private/.env

# snapshot original hashes to prove they are untouched (6)
find . -path ./.yuhi -prune -o -type f -print | sort | xargs shasum > /tmp/yuhi_before.sha

$YUHI prepare .        # (5) produces .yuhi/prepared/<id>/ ; (8) prints Estimated token reduction

find . -path ./.yuhi -prune -o -type f -print | sort | xargs shasum > /tmp/yuhi_after.sha
diff /tmp/yuhi_before.sha /tmp/yuhi_after.sha && echo "(6) SOURCE FILES UNCHANGED ✓"

ls -R .yuhi/prepared/*/          # (7) inspectable prepared artifact + manifest.json
cat .yuhi/prepared/*/manifest.json
# Confirm: students.csv identifiers pseudonymized; private/.env and private/ absent from
# the prepared output; logo.bin skipped; manifest shows provenance + reduction +
# transmission: "approved". Also confirm the generated API_KEY value appears NOWHERE
# under .yuhi/prepared/ :
! grep -rq "$(sed -n 's/^API_KEY=//p' private/.env)" .yuhi/prepared/ && echo "secret kept local ✓"

# CLEANUP: delete the throwaway secret.
rm -f private/.env
```

## 10. Localhost-only during preparation (PID-scoped)

Inspect **only the `yuhi prepare` process and its children** — not every Node process:

```bash
$YUHI prepare . & PREP_PID=$!
# collect the process subtree (parent + descendants) for the run's duration
conns=/tmp/yuhi_conns.txt; : > "$conns"
while kill -0 "$PREP_PID" 2>/dev/null; do
  pids="$PREP_PID $(pgrep -P "$PREP_PID" 2>/dev/null) $(pgrep -g "$(ps -o pgid= -p "$PREP_PID" | tr -d ' ')" 2>/dev/null)"
  for pid in $(echo "$pids" | tr ' ' '\n' | sort -u); do
    lsof -nP -iTCP -a -p "$pid" -s TCP:ESTABLISHED 2>/dev/null | awk 'NR>1{print $9}'
  done >> "$conns"
  sleep 0.3
done
wait "$PREP_PID"
# Every remote endpoint must be 127.0.0.1:11434 (or ::1). Anything else fails the test.
if sort -u "$conns" | grep -oE '\->[^ ]+' | grep -vE '127\.0\.0\.1:11434|\[::1\]:11434' | grep -q .; then
  echo "(10) NON-LOCAL CONNECTION DETECTED — FAIL"; sort -u "$conns"
else
  echo "(10) localhost-only (127.0.0.1:11434) ✓"
fi
```

---

## 9 + GUI. Clean VS Code profile install

```bash
cd ~/Documents/yuhi
pnpm --filter yuhi-vscode build && pnpm --filter yuhi-vscode package   # -> apps/vscode/yuhi.vsix
TMP=$(mktemp -d)
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" --install-extension apps/vscode/yuhi.vsix
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" ~/Documents/yuhi/examples/acceptance-fixture
```

### Manual GUI checklist (clean profile)

- [ ] Extension activates; status bar shows a **Yuhi** state.
- [ ] Command Palette → **Yuhi: Doctor** → shows Ready (or actionable state).
- [ ] Temporarily `pkill ollama` → Doctor shows **Ollama stopped**; restart → Ready. (Ollama-stopped)
- [ ] Rename the model in config / pick an uninstalled model → **Model missing** state. (model-missing)
- [ ] **Yuhi: Setup Local AI** → model selector (qwen3:1.7b preselected, size shown) → asks confirmation → pulls with progress → smoke test. (setup + pull)
- [ ] **Ollama-missing** (do NOT uninstall Ollama): relaunch the clean profile with a
      **restricted PATH** that excludes the Ollama binary, then run **Yuhi: Setup Local AI** →
      an **Install Ollama** action opens ollama.com/download; nothing installs silently.

      ```bash
      # minimal PATH without Ollama's dir (adjust to where `ollama` lives, e.g. /usr/local/bin)
      env PATH="/usr/bin:/bin" code \
        --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" \
        ~/Documents/yuhi/examples/acceptance-fixture
      ```
- [ ] **Yuhi: Prepare Workspace** → progress notification, cancellable → completes.
- [ ] **Yuhi: Review Prepared Context** → **Context Savings** panel shows Original / Prepared **Estimated tokens**, reduction %, excluded/summarized/sensitive counts, "Source files modified: 0".
- [ ] Per-file **Original ↔ Prepared** diff opens.
- [ ] Explorer right-click a file/folder → **Prepare with Yuhi** works.
- [ ] Source files in the workspace are unchanged; nothing is sent to Claude (no forwarding in this beta).

---

## Marketplace publisher requirements (manual — permanent identity)

1. Create/confirm a **Marketplace publisher** (e.g. `yuhi-ai-labs`) at
   https://marketplace.visualstudio.com/manage — this is a permanent public identity.
2. Create an Azure DevOps **Personal Access Token** (scope: *Marketplace → Manage*).
3. Set `publisher` in `apps/vscode/package.json` to the confirmed id.

### Exact publish command (do NOT run until approved)

```bash
cd ~/Documents/yuhi/apps/vscode
npx vsce login <publisher>       # paste the PAT
npx vsce publish                 # or: npx vsce publish --packagePath yuhi.vsix
```

## Status labels

- **Now (pre-real-test):** VS Code — *In development* · Ollama local preparation — *In development*
- **After real-Ollama + clean-profile pass:** VS Code — *Beta — release ready*
- **After Marketplace publish:** VS Code — *Available — Beta*
