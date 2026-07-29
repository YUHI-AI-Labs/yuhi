# Yuhi VS Code beta — 10-minute clean-profile GUI checklist

Prereqs: Ollama running + `qwen3:1.7b` installed (`ollama pull qwen3:1.7b`).
Save screenshots under `/tmp/yuhi-vscode-acceptance/` (not committed).
Mark each: **[ ] pass  [ ] fail** and note any defect.

---

## A. Build & install

```bash
cd ~/Documents/yuhi
pnpm --filter yuhi-vscode build
pnpm --filter yuhi-vscode package                 # → apps/vscode/yuhi.vsix
TMP=$(mktemp -d)
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" --install-extension apps/vscode/yuhi.vsix
code --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" examples/acceptance-fixture
```
- [ ] VSIX installs and the window opens on the fixture folder. — defect: ________

## B. Ready state — Command Palette → **Yuhi: Doctor**
Expect: status bar visible · **Local AI: Ready** · inference smoke test passed · `qwen3:1.7b` shown · one clear next action · no raw stack trace.
- [ ] pass / [ ] fail — 📸 `01-yuhi-ready.png` — defect: ________

## C. Preparation progress — Command Palette → **Yuhi: Prepare Workspace**
Expect: understandable workspace name/path · visible progress · visible **Cancel** · UI not frozen · no source file changes during prep.
- [ ] pass / [ ] fail — 📸 `02-prepare-progress.png` — defect: ________

## D. Context Savings (opens automatically after completion)
Leading metric = **Estimated Claude input avoided**. Also visible: estimated input before · after · avoided tokens · reduction % · excluded · summarized · masked · sensitive kept local · failed · **Source files modified: 0** · billing disclaimer · outcome (**Complete / Complete with warnings / Partial / Failed**).
- [ ] pass / [ ] fail — 📸 `03-context-savings.png` — defect: ________

## E. Review — Command Palette → **Yuhi: Review Prepared Context**
Expect: original **left**, prepared **right** · correct paths · **no `<think>`** · pseudonymized content visible · **original secret values NOT visible** · excluded/kept-local files show no misleading diff.
- [ ] pass / [ ] fail — 📸 `04-original-prepared-diff.png` — defect: ________

## F. Next actions (all four)
**Review Prepared Context · Open Prepared Workspace · Copy Prepared Path · Run Again.**
Expect: every button works · no dead end · copied path exists · prepared workspace opens · Run Again starts a new prep safely.
- [ ] pass / [ ] fail — 📸 `05-next-actions.png` — defect: ________

## G. Failure state (do NOT uninstall/delete anything)
```bash
brew services stop ollama        # or: pkill -f "ollama serve"   (temporary)
```
Command Palette → **Yuhi: Doctor**. Expect: **not** Ready · **Inference failed** prominent · understandable reason · suggested recovery actions · source files unchanged · no unsafe prepared result offered · no external forwarding. Then restore:
```bash
brew services start ollama       # or: ollama serve &
```
- [ ] pass / [ ] fail — 📸 `06-failure-state.png` — defect: ________

## H. Visual quality
- [ ] dark theme  - [ ] light theme  - [ ] narrow panel  - [ ] long filename  - [ ] long error message
- [ ] keyboard tab nav + visible focus  - [ ] no horizontal clipping  - [ ] no overlapping buttons
- [ ] no raw HTML / translation keys  - [ ] readable contrast — defect: ________

---

## Result (circle one)
**PASS** · **PASS WITH MINOR ISSUES** · **FAIL** — notes: ________________________

### Fix-immediately defects (release-blocking)
command does nothing · blank/broken webview · misleading Ready · missing primary metric ·
incorrect diff · secret exposure · `<think>` exposure · dead button · hidden failure ·
source-file modification · use-blocking clipping · inaccessible primary action.

### Not release-blocking (do not delay)
minor copy · cosmetic spacing · README branding · dangling sourceMappingURL · issue drafts · future providers.
