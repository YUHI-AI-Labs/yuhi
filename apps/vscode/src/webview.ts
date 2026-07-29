import type { PreparedMetrics, PreparedRuntimeBoundary } from "@yuhi/core";

export interface ReviewFile {
  path: string;
  action: string;
  status: string;
  omitted: boolean;
  beforeTokens: number;
  afterTokens: number;
  diffable: boolean;
  sensitivity: string;
  findingCategoryCounts: Record<string, number>;
  findingCount: number;
  rule: string;
  reason: string;
  classificationSource: string;
  included: boolean;
  claudeReceives: "Unchanged" | "Transformed" | "No";
  transformed: boolean;
  transformations: ("summarized" | "aggregated" | "pseudonymized" | "masked")[];
  unresolvedHighRiskCount: number;
  outcome?: string;
  fileType?: string;
  inspectionStatus?: string;
  limitationShown?: boolean;
}

export interface ReviewData {
  launchDecisionEnabled: boolean;
  /** A standalone review opened inside an already-validated Prepared Workspace. */
  openClaudeHereEnabled: boolean;
  project: string;
  agent: string;
  runId: string;
  outcome: string;
  osSandboxEnabled: false;
  outDir: string;
  report: {
    beforeTokens: number;
    afterTokens: number;
    tokensSaved: number;
    percentReduction: number;
    hasData: boolean;
    filesExcluded: number;
    filesSummarized: number;
    sensitiveMasked: number;
    sourceModified: number;
    approx: boolean;
  };
  metrics: PreparedMetrics;
  runtime: PreparedRuntimeBoundary;
  acceptance: {
    entitiesPseudonymized: number;
    identifierColumnsTransformed: number;
    analyticalColumnsPreserved: number;
    postTransformScanPassed: boolean;
    malformedTables: number;
    unverifiedTransformations: number;
    rawFallbackUsed: false;
    launchAllowed: boolean;
    claudeCodeStarted: boolean;
    unsupportedOrUnverifiedFiles?: number;
    restrictedUnresolvedFiles?: number;
    hasLimitations?: boolean;
  };
  files: ReviewFile[];
  projectFiles: string[];
  metadataFiles: string[];
  preparedTree: string[];
}

export function renderSavingsHtml(data: ReviewData, _cspSource: string, nonce: string): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const launch = data.launchDecisionEnabled
    ? '<button class="button primary launchAction">Open with Claude Code</button>'
    : data.openClaudeHereEnabled
      ? '<button class="button primary openClaudeHere">Open Claude Code</button>'
    : "";
  const cancelLabel = data.launchDecisionEnabled ? "Cancel" : "Close";
  const recoveryActions = data.outcome === "Partial"
    ? '<button class="button primary" id="excludeBlocked">Exclude blocked files and prepare again</button><button class="button" id="reviewBlocked">Review blocked files</button><button class="button" id="chooseSource">Choose another source folder</button>'
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:var(--vscode-editor-background,#0b0b0b);--fg:var(--vscode-editor-foreground,#f5f5f5);--muted:var(--vscode-descriptionForeground,#a3a3a3);--panel:var(--vscode-sideBar-background,#121212);--line:var(--vscode-panel-border,#303030);--accent:var(--vscode-button-background,#fff);--accent-fg:var(--vscode-button-foreground,#000);--soft:var(--vscode-list-hoverBackground,#202020);--good:#67d391;--warn:var(--vscode-notificationsWarningIcon-foreground,#d9a441);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:var(--vscode-font-family,system-ui,sans-serif)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans);overflow-x:hidden}
.wrap{width:min(1160px,100%);margin:auto;padding:32px 28px 110px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.hero{padding:34px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}h1{font-size:32px;line-height:1.15;margin:8px 0 8px;letter-spacing:-.03em}h2{font-size:20px;margin:34px 0 5px}h3{font-size:14px;margin:0}.lead{font-size:16px;color:var(--muted);margin:0 0 22px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}.pill{border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted)}.pill b{color:var(--fg)}
.hero-top{display:flex;justify-content:space-between;gap:16px}.ready{font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--good)}
.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.button{border:1px solid var(--line);border-radius:8px;padding:9px 15px;background:transparent;color:var(--fg);font:600 14px var(--sans);cursor:pointer}.button:hover{background:var(--soft)}.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:800}.link{border:0;background:none;color:var(--fg);text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:9px}
.sub{color:var(--muted);margin:0 0 14px}.card{border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}.groups{display:grid;grid-template-columns:1fr 1fr}.group{padding:18px}.group+.group{border-left:1px solid var(--line)}.count{color:var(--muted);font-weight:400}.file-list{list-style:none;padding:0;margin:10px 0 0}.file-list li{display:flex;gap:9px;align-items:center;padding:6px 0;min-width:0}.file-list code{font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file-icon{color:var(--muted)}details.metadata{border-top:1px solid var(--line);padding:0 18px 14px}details summary{cursor:pointer;padding:13px 0;font-weight:700;color:var(--muted)}.note{font-size:12px;color:var(--muted)}
.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.metric b{display:block;font:700 24px var(--mono)}.metric span{color:var(--muted)}.metric.reduction{grid-column:span 2}.metric.reduction b{font-family:var(--sans)}.explanation{font-size:12px;margin-top:5px;color:var(--muted)}
.calm{margin-top:28px;padding:15px 17px;border-left:3px solid var(--warn);background:var(--panel);border-radius:4px 12px 12px 4px}.calm p{margin:0}.calm details summary{padding-bottom:3px}.calm .detail{color:var(--muted);font-size:13px}
.empty-state{padding:16px;color:var(--muted)}.toolbar{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px}.table{overflow:hidden}.row{display:grid;grid-template-columns:minmax(180px,1.5fr) 150px 140px minmax(180px,1fr);gap:14px;align-items:center;padding:11px 14px;border-top:1px solid var(--line);min-width:0}.row.head{position:sticky;top:0;background:var(--panel);z-index:1;border-top:0;color:var(--muted);font-size:11px;text-transform:uppercase}.path{font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.diff{border:0;background:none;color:var(--fg);text-align:left;padding:0;cursor:pointer}.why{color:var(--muted);font-size:13px}.badge{width:max-content;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:12px}.advanced-row{padding:10px 14px;border-top:1px dashed var(--line);color:var(--muted);font-size:12px}
.advanced{margin-top:28px}.advanced .inside{padding:4px 18px 18px}.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 24px}.fact{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid var(--line)}.fact span{color:var(--muted)}.sticky{position:fixed;z-index:4;left:0;right:0;bottom:0;border-top:1px solid var(--line);background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px)}.sticky .inner{width:min(1160px,100%);margin:auto;padding:12px 28px;display:flex;justify-content:flex-end;gap:10px}
@media(max-width:800px){.wrap{padding:20px 16px 100px}.hero{padding:24px}h1{font-size:27px}.groups{grid-template-columns:1fr}.group+.group{border-left:0;border-top:1px solid var(--line)}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.row{grid-template-columns:minmax(150px,1fr) 130px 120px}.row>*:nth-child(4){display:none}.advanced-grid{grid-template-columns:1fr}.sticky .inner{padding:10px 16px}.metric.reduction{grid-column:1/-1}}
@media(max-width:520px){.summary-grid{grid-template-columns:1fr}.metric.reduction{grid-column:auto}.row{grid-template-columns:minmax(130px,1fr) 115px}.row>*:nth-child(3),.row>*:nth-child(4){display:none}.hero .actions{align-items:stretch}.hero .actions .button{width:100%}}
</style></head><body><main class="wrap">
<section class="hero">
 <div class="hero-top"><div class="eyebrow">YUHI</div><div class="ready">${data.outcome === "Partial" ? "BLOCKED" : data.acceptance.hasLimitations ? "LIMITED" : "READY"}</div></div><h1>${data.outcome === "Partial" ? "Preparation incomplete" : data.acceptance.hasLimitations ? "Prepared with limitations" : "Ready for Claude Code"}</h1>
 <p class="lead" id="heroLead"></p>
 <div class="facts" id="heroFacts"></div>
 <div class="actions">${launch}${recoveryActions}<button class="button" id="review">View files</button><button class="link" id="cancel">${cancelLabel}</button></div>
 <p class="sub">${data.outcome === "Partial" ? "Some files could not be safely prepared. Claude Code was not started." : "Claude Code will start in the Prepared Workspace."}</p>
</section>
<section id="files"><h2 id="receiveTitle"></h2><p class="sub">This is the actual Prepared Workspace, not your original workspace.</p>
 <div class="card"><div class="groups"><div class="group"><h3>Project files <span class="count" id="projectCount"></span></h3><ul class="file-list" id="projectFiles"></ul></div>
 <div class="group"><h3>Result</h3><div id="fileResult" class="empty-state"></div></div></div>
 <details class="metadata"><summary id="metadataTitle"></summary><p class="note">Yuhi metadata supports review and audit. It is not part of your project source. These files are present in the Prepared Workspace and Claude Code may read them.</p><ul class="file-list" id="metadataFiles"></ul></details></div>
</section>
<aside class="calm" id="privacyDecision" hidden></aside>
<section><h2>Preparation summary</h2><p class="sub">A concise view of what Yuhi changed before handoff.</p><div class="summary-grid" id="summary"></div></section>
<aside class="calm"><p><b id="runtimeNotice"></b></p><details><summary>Runtime boundary details</summary><div class="detail" id="runtimeExplanation"></div><div id="runtimeFacts"></div></details></aside>
<details class="card advanced"><summary>Advanced details</summary><div class="inside"><div class="advanced-grid" id="advanced"></div><h3>Scanner and policy details</h3><div class="advanced-grid" id="scanner"></div><p class="note">Estimated context reduction is calculated from Prepared Workspace content. Actual agent usage may differ because of system prompts, tool output, conversation history, and caching. This is not a billing or cost-savings measurement.</p></div></details>
<details class="card advanced"><summary>Full file decisions</summary><div class="inside"><p class="sub">Why each project file was included, changed, or withheld.</p><div class="card table"><div class="toolbar"><label for="filter">Show</label><select id="filter"><option value="all">All files</option><option value="included">Included</option><option value="transformed">Transformed</option><option value="excluded">Excluded</option><option value="kept">Kept local</option></select></div><div id="decisions"></div></div></div></details>
</main>
<div class="sticky"><div class="inner"><button class="button" id="backToFiles">Back to files</button>${launch}<button class="link" id="cancelSticky">${cancelLabel}</button></div></div>
<script nonce="${nonce}">
const DATA=${json},vscode=acquireVsCodeApi(),m=DATA.metrics,r=DATA.report,a=DATA.acceptance;
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const nf=n=>Intl.NumberFormat().format(n),pct=m.estimatedReductionPercent.toFixed(1);
const transformed=m.preparedFilesModified,included=DATA.projectFiles.length;
const enforced=DATA.runtime.filesystemEnforcement==="claude-code-sandbox"&&DATA.runtime.osSandboxEnabled&&!DATA.runtime.externalPathAccessPossible;
document.getElementById("runtimeNotice").textContent=enforced?"Yuhi prepared the initial context. Claude Code sandbox policy is enforced.":"Yuhi prepared the initial context. External filesystem access is not restricted.";
document.getElementById("runtimeExplanation").textContent=enforced?"Claude Code starts in the Prepared Workspace. Yuhi denies reads from the home directory and re-allows only this Prepared Workspace. Launch fails if the sandbox policy cannot be installed or verified.":"This is an advisory Prepared Workspace. Return to the original workspace and prepare again before launching Claude Code.";
document.getElementById("heroLead").textContent=included+" project "+(included===1?"file was":"files were")+" reviewed and prepared. Your original workspace was not modified.";
document.getElementById("heroFacts").innerHTML=[
 [included,"Included"],[transformed,"Transformed"],[m.sensitiveValuesMasked,"Masked"],[m.filesExcluded+m.filesKeptLocal,"Withheld"],[m.originalSourceFilesModified,"Source changed"]
].map(x=>'<span class="pill"><b>'+x[0]+'</b> '+x[1]+'</span>').join("");
document.getElementById("receiveTitle").textContent="Claude Code will receive "+included+" project "+(included===1?"file":"files");
document.getElementById("projectCount").textContent="· "+included;
const fileList=items=>items.length?items.map(p=>'<li title="'+esc(p)+'"><span class="file-icon">□</span><code>'+esc(p)+'</code></li>').join(""):'<li class="note">None</li>';
document.getElementById("projectFiles").innerHTML=fileList(DATA.projectFiles);
document.getElementById("metadataTitle").textContent="Yuhi metadata · "+DATA.metadataFiles.length+" "+(DATA.metadataFiles.length===1?"file":"files");
document.getElementById("metadataFiles").innerHTML=fileList(DATA.metadataFiles);
document.getElementById("fileResult").textContent=transformed===0?"All included files are unchanged":transformed+" included "+(transformed===1?"file was":"files were")+" transformed";
const reductionNote=!r.hasData?"Token estimate unavailable.":m.estimatedReductionPercent===0?"No reduction was applied because all included files were kept unchanged.":m.estimatedReductionPercent<0?"Prepared content is larger than the original estimate.":nf(r.beforeTokens)+" → "+nf(r.afterTokens)+" estimated tokens";
const cards=[["Included",included],["Transformed",transformed],["Masked values",m.sensitiveValuesMasked],["Excluded",m.filesExcluded],["Kept local",m.filesKeptLocal],["Source changed",m.originalSourceFilesModified]];
document.getElementById("summary").innerHTML='<div class="metric reduction"><span>Estimated context reduction</span><b>'+pct+'%</b><div class="explanation">'+esc(reductionNote)+'</div></div>'+cards.map(x=>'<div class="metric"><span>'+x[0]+'</span><b>'+x[1]+'</b></div>').join("");
const facts=items=>items.map(x=>'<div class="fact"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>').join("");
const restricted=DATA.files.filter(f=>f.sensitivity==="Restricted"),limited=DATA.files.filter(f=>f.limitationShown),box=document.getElementById("privacyDecision");
const limitationDetails=()=>limited.map(f=>"<p><b>"+(f.sensitivity==="Restricted"?"Restricted workbook kept local":"File kept local")+"</b></p>"+facts([["Type",f.fileType??"Unknown"],["Inspection",f.inspectionStatus??"Not available"],["Transformation",f.outcome==="local-only-unverified"?"Not available":"Not attempted"],["Claude receives","Nothing"],["Reason",f.fileType==="PDF"?"No verified local PDF inspection is available":"Verified local inspection or transformation is unavailable"],["Unresolved high-risk data",f.sensitivity==="Restricted"?"Yes":"No"]])).join("");
if(DATA.outcome==="Partial"){box.hidden=false;box.innerHTML="<p><b>Preparation incomplete</b></p>"+facts([["Malformed tables",String(a.malformedTables)],["Unverified transformations",String(a.unverifiedTransformations)],["Unsupported or unverified files",String(a.unsupportedOrUnverifiedFiles??0)],["Restricted unresolved files",String(a.restrictedUnresolvedFiles??0)],["Files kept local",String(m.filesKeptLocal)],["Raw fallback used","No"],["Claude Code started","No"]])+"<p>Some files could not be safely inspected or transformed.</p>"+limitationDetails()}
else if(a.hasLimitations){box.hidden=false;box.innerHTML="<p><b>Some files could not be safely inspected or transformed.</b></p>"+facts([["Unsupported or unverified files",String(a.unsupportedOrUnverifiedFiles??0)],["Restricted unresolved files",String(a.restrictedUnresolvedFiles??0)],["Raw fallback used","No"]])+limitationDetails()}
else if(restricted.length){box.hidden=false;box.innerHTML="<p><b>Restricted tabular data transformed locally</b></p>"+facts([["Entities pseudonymized",String(a.entitiesPseudonymized)],["Identifier columns transformed",String(a.identifierColumnsTransformed)],["Analytical columns preserved",String(a.analyticalColumnsPreserved)],["Post-transformation scan",a.postTransformScanPassed?"Passed":"Failed"],["Raw fallback used","No"],["Original source modified","No"],["Claude receives","Verified transformed copy"]])}
document.getElementById("runtimeFacts").innerHTML=facts([["Starts in","Prepared Workspace"],["Workspace boundary",DATA.runtime.workspaceBoundary==="enforced"?"Enforced":"Advisory"],["Filesystem enforcement",DATA.runtime.filesystemEnforcement==="claude-code-sandbox"?"Claude Code sandbox":"Not enabled"],["OS sandbox",DATA.runtime.osSandboxEnabled?"Enabled":"Not enabled"],["External-path access",DATA.runtime.externalPathAccessPossible?"May still be possible":"Blocked by policy"]]);
const action=f=>f.outcome==="local-only-unsupported"?"File kept local":f.outcome==="local-only-unverified"?"Restricted workbook kept local":f.outcome==="excluded-by-user"?"Excluded by user":f.outcome==="excluded-by-policy"?"Excluded by policy":f.omitted?(["local-only","inject","ask","metadata-only"].includes(f.action)?"Kept local":"Excluded"):f.transformations.includes("aggregated")?"Aggregated locally":f.transformations.includes("pseudonymized")?"Pseudonymized locally":f.transformations.includes("masked")?"Masked locally":f.transformations.includes("summarized")?"Summarized locally":"Included unchanged";
const receive=f=>f.claudeReceives==="No"?"Nothing":f.transformations.includes("aggregated")?"Aggregated copy":f.transformations.includes("pseudonymized")?"Pseudonymized copy":f.transformed?"Prepared copy":"Unchanged";
const files=DATA.files.slice().sort((a,b)=>a.path.localeCompare(b.path)),decisions=document.getElementById("decisions");
function render(selected){const shown=files.filter(f=>selected==="all"||selected==="included"&&f.included||selected==="transformed"&&f.transformed||selected==="excluded"&&f.omitted&&!["local-only","inject","ask","metadata-only"].includes(f.action)||selected==="kept"&&f.omitted&&["local-only","inject","ask","metadata-only"].includes(f.action));if(!shown.length){decisions.innerHTML='<div class="empty-state">No matching files.</div>';return}decisions.innerHTML='<div class="row head"><span>File</span><span>Yuhi action</span><span>Claude receives</span><span>Why</span></div>'+shown.map(f=>{const p='<span class="path" title="'+esc(f.path)+'">'+esc(f.path)+'</span>';return '<div class="row">'+(f.diffable?'<button class="diff" data-p="'+esc(f.path)+'">'+p+'</button>':p)+'<span class="badge">'+action(f)+'</span><span>'+receive(f)+'</span><span class="why">'+esc(f.reason)+'</span></div>'}).join("")}
render("all");document.getElementById("filter").addEventListener("change",e=>render(e.target.value));decisions.addEventListener("click",e=>{const row=e.target.closest(".diff");if(row)vscode.postMessage({type:"diff",path:row.dataset.p})});
document.getElementById("advanced").innerHTML=facts([["Preparation result",DATA.outcome],["Run ID",DATA.runId],["Prepared output",DATA.outDir],["Project files inspected",String(m.filesInspected)],["Project files included",String(included)],["Generated Yuhi metadata files",String(DATA.metadataFiles.length)],["Estimated tokens before",String(r.beforeTokens)],["Estimated tokens after",String(r.afterTokens)]]);
const noFindings=m.sensitiveFindings===0?"No sensitive findings detected":m.sensitiveFindings+" sensitive findings detected";
const noWithheld=m.filesExcluded===0&&m.filesKeptLocal===0?"No files were withheld":m.filesExcluded+" excluded · "+m.filesKeptLocal+" kept local";
document.getElementById("scanner").innerHTML='<p>'+esc(noFindings)+'</p><p>'+esc(noWithheld)+'</p>'+facts([["Files containing findings",String(m.filesWithSensitiveFindings)],["Files containing masked values",String(m.filesWithMaskedValues)],["Unresolved high-risk findings",String(m.unresolvedHighRiskFindings)]]);
const send=t=>vscode.postMessage({type:t});document.querySelectorAll(".launchAction").forEach(b=>b.addEventListener("click",()=>send("launch")));document.querySelectorAll(".openClaudeHere").forEach(b=>b.addEventListener("click",()=>send("openClaudeHere")));document.querySelectorAll("#cancel,#cancelSticky").forEach(b=>b.addEventListener("click",()=>send("cancel")));document.getElementById("review").addEventListener("click",()=>document.getElementById("files").scrollIntoView());document.getElementById("backToFiles").addEventListener("click",()=>document.getElementById("files").scrollIntoView());
document.getElementById("excludeBlocked")?.addEventListener("click",()=>send("excludeBlockedAndRetry"));document.getElementById("reviewBlocked")?.addEventListener("click",()=>{document.getElementById("filter").value="kept";render("kept");document.getElementById("files").scrollIntoView()});document.getElementById("chooseSource")?.addEventListener("click",()=>send("chooseSource"));
</script></body></html>`;
}
