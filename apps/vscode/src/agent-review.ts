import path from "node:path";
import type { PatchReviewResult } from "@yuhi/core";
import type { PatchChange } from "@yuhi/core";

/**
 * Resolve diff inputs from agent-session state. The left side is always the
 * immutable pre-agent Prepared snapshot, never the mutable Original Workspace.
 */
export function agentDiffTargets(
  privateSessionRoot: string,
  preparedRoot: string,
  change: PatchChange,
): { baseline?: string; agent: string } {
  const rel = (change.previousRelpath ?? change.relpath).split("/");
  return {
    ...(change.kind === "added"
      ? {}
      : { baseline: path.join(privateSessionRoot, "prepared-baseline", ...rel) }),
    agent: path.join(preparedRoot, ...change.relpath.split("/")),
  };
}

/** Resolve a webview file selection against a freshly rescanned review. */
export function selectedApplicableChanges(
  review: PatchReviewResult,
  relpaths: readonly string[],
) {
  const selected = new Set(relpaths);
  return review.changes.filter(
    (change) => selected.has(change.relpath) && change.applyEligibility !== "blocked",
  );
}

export function renderAgentChangeReviewHtml(
  review: PatchReviewResult,
  agentName = "AI Agent",
): string {
  // Diff content is rendered only after an explicit Open Diff action. Keeping
  // it out of the HTML prevents file content from hiding in webview state.
  const { diffsByRelpath: _diffs, ...metadataOnlyReview } = review;
  const data = JSON.stringify({ review: metadataOnlyReview, agentName }).replaceAll("<", "\\u003c");
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:14px/1.5 var(--vscode-font-family);padding:32px}.wrap{max-width:880px;margin:auto}h1{font-size:26px;margin:0 0 4px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px}.card{border:1px solid var(--vscode-panel-border);padding:20px;margin:20px 0;background:var(--vscode-sideBar-background)}.ok{border-left:4px solid var(--vscode-testing-iconPassed)}.blocked{border-left:4px solid var(--vscode-testing-iconFailed)}.row{display:grid;grid-template-columns:100px 1fr;padding:9px 0;border-bottom:1px solid var(--vscode-panel-border)}.row:last-child{border:0}.kind{text-transform:capitalize}.path{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:10px;position:sticky;bottom:0;padding:16px 0;background:var(--vscode-editor-background)}button{border:1px solid var(--vscode-button-border,transparent);padding:8px 14px;cursor:pointer}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.5;cursor:not-allowed}.note{color:var(--vscode-descriptionForeground)}
</style></head><body><main class="wrap">
<div class="eyebrow">Safe Agent Execution</div><h1 id="title"></h1><p class="note">The agent worked in the Prepared Workspace. Nothing is applied automatically.</p>
<section class="card" id="security"></section>
<section><h2 id="count"></h2><p class="note" id="eligibility"></p><div class="card" id="changes"></div></section>
<div class="actions"><button id="diff">Open Diff</button><button class="primary" id="apply">Apply selected</button><button id="discard">Discard agent changes</button><button id="stopYuhi">Stop Yuhi and Return</button><button id="switchWorkspace">Choose Another Workspace</button></div>
</main><script nonce="${nonce}">
const DATA=${data},r=DATA.review,vscode=acquireVsCodeApi(),esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const reasonLabel=s=>({"patch-added":"Created by the agent","patch-modified":"Modified by the agent","patch-deleted":"Deleted by the agent","patch-renamed":"Renamed by the agent","patch-binary":"Binary change requires review","patch-compressed-source":"Compressed context cannot be applied automatically","patch-background-artifact":"Yuhi-generated context cannot be applied","patch-source-changed":"Original Workspace changed since preparation","patch-path-escape":"Path leaves the Original Workspace","patch-symlink":"Redirected or symbolic path detected","patch-secret-added":"Generated content contains a secret or credential","patch-pii-added":"Generated content contains personal information","patch-sensitive-config":"Sensitive configuration requires review","patch-generated-large-file":"Large generated file requires review","patch-unsupported-mode":"File mode change cannot be applied safely","patch-eligible":"Eligible for explicit Apply"}[s]||s);
document.getElementById("title").textContent=DATA.agentName+" with Yuhi";
const selectable=r.changes.some(c=>c.applyEligibility!=="blocked");
const security=document.getElementById("security");security.className="card "+(selectable?"ok":"blocked");
security.innerHTML=selectable?"<h2>Changes ready for review</h2><p>✓ Eligible proposed bytes passed the current security checks</p><p>Nothing is applied automatically.</p>":"<h2>Some changes cannot be applied</h2><p>Blocked changes remain in the Prepared Workspace.</p>";
document.getElementById("count").textContent=r.changes.length+" files changed";
document.getElementById("eligibility").textContent="Low risk: "+r.counts.low+" · Review: "+r.counts.review+" · High risk: "+r.counts.high+" · Blocked: "+r.counts.blocked;
document.getElementById("changes").innerHTML=r.changes.length?r.changes.map((c,i)=>{const hs=r.hunksByRelpath[c.relpath]||[];const hunkUi=hs.length>1?'<details><summary>Select hunks ('+hs.length+')</summary>'+hs.map((h,n)=>'<label><input class=hunk type=checkbox data-rel="'+esc(c.relpath)+'" data-hid="'+esc(h.hunkId)+'" checked> Hunk '+(n+1)+' · lines '+(h.beforeStart+1)+'–'+(h.beforeStart+h.beforeCount)+'</label><br>').join('')+'</details>':'';return '<div class=row><b class=kind><input class=pick type=checkbox data-i="'+i+'" '+(c.applyEligibility==="eligible"?'checked':c.applyEligibility==="blocked"?'disabled':'')+' aria-label="Select '+esc(c.relpath)+'"> '+esc(c.kind)+'</b><span class=path>'+esc((c.previousRelpath?c.previousRelpath+" → ":"")+c.relpath)+'<br><small>'+esc(c.applyEligibility)+" · "+esc(c.risk||"blocked")+" risk · "+esc(c.representation)+" · "+Number(c.beforeSizeBytes||0)+" → "+Number(c.afterSizeBytes||0)+" bytes"+(c.sourceChanged?" · Source changed since baseline":"")+"<br>"+c.reasonCodes.map(x=>esc(reasonLabel(x))).join(" · ")+'</small>'+hunkUi+'</span></div>'}).join(""):"<p>No project file changes detected.</p>";
const selected=()=>[...document.querySelectorAll('.pick:checked')].map(x=>r.changes[Number(x.dataset.i)].relpath);
const hunkSelections=()=>{const value={};for(const input of document.querySelectorAll('.hunk')){value[input.dataset.rel]??=[];if(input.checked)value[input.dataset.rel].push(input.dataset.hid)}return value};
const update=()=>document.getElementById("apply").disabled=selected().length===0;
document.querySelectorAll('.pick').forEach(x=>x.addEventListener('change',update));update();
document.getElementById("diff").addEventListener("click",()=>vscode.postMessage({type:"diff"}));
document.getElementById("apply").addEventListener("click",()=>vscode.postMessage({type:"apply",relpaths:selected(),hunkSelections:hunkSelections()}));
for(const [id,type] of [["stopYuhi","stopYuhi"],["switchWorkspace","switchWorkspace"],["discard","discard"]])document.getElementById(id).addEventListener("click",()=>vscode.postMessage({type}));
</script></body></html>`;
}
