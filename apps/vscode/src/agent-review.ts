import type { AgentChangeReview } from "@yuhi/core";

export function renderAgentChangeReviewHtml(
  review: AgentChangeReview,
  agentName = "AI Agent",
): string {
  const data = JSON.stringify({ review, agentName }).replaceAll("<", "\\u003c");
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
<div class="actions"><button id="diff">Open Diff</button><button class="primary" id="apply">Apply to Original Workspace</button><button id="stopYuhi">Stop Yuhi and Return</button><button id="switchWorkspace">Choose Another Workspace</button><button id="discard">Close</button></div>
</main><script nonce="${nonce}">
const DATA=${data},r=DATA.review,vscode=acquireVsCodeApi(),esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const reasonLabel=s=>({"sensitive-output":"Secret or sensitive data detected","uninspectable-output":"Generated file could not be safely inspected","ineligible-provenance":"A changed file was transformed or withheld by Yuhi","original-conflict":"Original Workspace changed since preparation","original-git-dirty":"Affected source file has uncommitted Git changes","unsafe-path":"Unsafe or redirected path detected","internal-metadata-change":"Yuhi internal metadata changed","pseudonymized-by-yuhi-no-reversible-mapping":"This file was pseudonymized by Yuhi. Automatic apply is disabled because the original mapping is not available","masked-by-yuhi":"This file was masked by Yuhi and cannot be applied automatically","summarized-by-yuhi":"This file was summarized by Yuhi and cannot be applied automatically","aggregated-by-yuhi":"This file was aggregated by Yuhi and cannot be applied automatically","withheld-by-yuhi":"This file was kept local or excluded by Yuhi","manifest-included-unchanged":"Verified unchanged source provenance","agent-created-file":"New agent output"}[s]||s);
document.getElementById("title").textContent=DATA.agentName+" with Yuhi";
const security=document.getElementById("security");security.className="card "+(r.applyAllowed?"ok":"blocked");
security.innerHTML=r.applyAllowed?"<h2>Agent completed</h2><p>✓ No high-risk secrets detected</p><p>✓ No unverified generated files detected</p>":"<h2>Cannot apply changes</h2><p>Yuhi blocked Apply until the listed safety or conflict issue is resolved.</p><p class=note>"+r.blockers.map(x=>esc(reasonLabel(x))).join(" · ")+"</p>";
document.getElementById("count").textContent=r.changes.length+" files changed";
const safe=r.changes.filter(c=>c.eligibility==="safe-to-apply").length,review=r.changes.filter(c=>c.eligibility==="review-required").length,blocked=r.changes.filter(c=>c.eligibility==="cannot-apply").length;
document.getElementById("eligibility").textContent="Safe to apply: "+safe+" · Review required: "+review+" · Cannot apply: "+blocked;
document.getElementById("changes").innerHTML=r.changes.length?r.changes.map(c=>'<div class=row><b class=kind>'+esc(c.kind)+'</b><span class=path>'+esc((c.previousRelpath?c.previousRelpath+" → ":"")+c.relpath)+'<br><small>'+esc(c.eligibility)+" · "+esc(reasonLabel(c.eligibilityReason))+'</small></span></div>').join(""):"<p>No project file changes detected.</p>";
document.getElementById("apply").disabled=!r.applyAllowed||r.changes.length===0;
for(const [id,type] of [["diff","diff"],["apply","apply"],["stopYuhi","stopYuhi"],["switchWorkspace","switchWorkspace"],["discard","discard"]])document.getElementById(id).addEventListener("click",()=>vscode.postMessage({type}));
</script></body></html>`;
}
