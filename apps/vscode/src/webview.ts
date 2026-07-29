/**
 * "Context Savings" review webview. Shows Original vs Prepared *estimated* tokens,
 * the reduction, which files were excluded / summarized / had sensitive values
 * masked, and the invariant "Source files modified: 0". Each file offers an
 * Original ↔ Prepared diff (handled by the extension via vscode.diff).
 *
 * Vocabulary is deliberately plain: no processor/provider jargon. Token counts are
 * always labelled "Estimated".
 */
import type { PreparedMetrics, PreparedRuntimeBoundary } from "@yuhi/core";

export interface ReviewFile {
  path: string;
  action: string;
  status: string;
  omitted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** true when a prepared copy exists that can be diffed against the original. */
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
  transformations: ("summarized" | "pseudonymized" | "masked")[];
  unresolvedHighRiskCount: number;
}

export interface ReviewData {
  project: string;
  agent: string;
  runId: string;
  outcome: string;
  osSandboxEnabled: false;
  /** Prepared output directory, relative to the workspace root (display only). */
  outDir: string;
  report: {
    beforeTokens: number;
    afterTokens: number;
    tokensSaved: number; // signed; negative = increase
    percentReduction: number; // signed fraction
    hasData: boolean;
    filesExcluded: number;
    filesSummarized: number;
    sensitiveMasked: number;
    sourceModified: number; // always 0
    approx: boolean;
  };
  metrics: PreparedMetrics;
  runtime: PreparedRuntimeBoundary;
  files: ReviewFile[];
  /** Exact current on-disk Prepared Workspace tree; never derived from the source tree. */
  preparedTree: string[];
}

export function renderSavingsHtml(data: ReviewData, _cspSource: string, nonce: string): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root{--ink:#f3f6fb;--muted:#8a97ab;--faint:#525d6d;--hair:#1f2836;--panel:#111621;--panel2:#0c1017;
    --green:#2ad46b;--purple:#b98cff;--gray:#7f8b9c;--green-b:#0d2c1c;--purple-b:#241a45;--gray-b:#161c26;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:var(--vscode-font-family,system-ui,sans-serif);}
  body.vscode-light{--ink:#0a0f19;--muted:#5a6678;--faint:#93a0b4;--hair:#e2e8f1;--panel:#fff;--panel2:#f5f8fc;--green:#0f9b48;--purple:#7b4fd8;--gray:#788498;--green-b:#e2f7ea;--purple-b:#f0e9fd;--gray-b:#eef2f7;}
  *{box-sizing:border-box}
  body{margin:0;background:transparent;color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.5}
  .wrap{padding:16px 18px 40px;max-width:960px;margin:0 auto}
  h1{font-size:16px;font-weight:800;margin:0 0 2px}
  .sub{color:var(--faint);font-size:12px;margin-bottom:16px}
  .sub code{font-family:var(--mono)}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:14px}
  .oc{border-radius:14px;padding:14px 16px;border:1px solid var(--hair);background:var(--panel)}
  .oc .n{font-family:var(--mono);font-weight:850;letter-spacing:-1px;font-size:30px;line-height:1}
  .oc .t{font-weight:700;font-size:12.5px;margin-top:7px}.oc .d{color:var(--faint);font-size:11px;margin-top:2px}
  .oc.before .n{color:var(--gray)} .oc.after .n{color:var(--green)}
  .oc.save{background:radial-gradient(120% 130% at 50% 0%,var(--purple-b),var(--panel) 72%);border-color:color-mix(in oklab,var(--purple) 42%,transparent)}
  .oc.save .n{color:var(--purple)}.oc.save .t{color:var(--purple)}
  .stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .stat{font-size:11.5px;padding:5px 10px;border:1px solid var(--hair);border-radius:999px;color:var(--muted);background:var(--panel)}
  .stat b{color:var(--ink);font-weight:750}
  .stat.safe{color:var(--green);border-color:color-mix(in oklab,var(--green) 38%,transparent);background:var(--green-b)}
  .card{background:var(--panel);border:1px solid var(--hair);border-radius:14px;overflow:hidden}
  .ch{padding:10px 14px;border-bottom:1px solid var(--hair);font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:var(--faint);font-weight:600;display:flex;justify-content:space-between}
  .list{padding:5px;max-height:56vh;overflow:auto}
  .row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;color:var(--ink);font:inherit;padding:8px 9px;border-radius:9px}
  .row.diffable{cursor:pointer}.row.diffable:hover{background:var(--panel2)}
  .row .fp{font-family:var(--mono);font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .tk{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap}
  .badge{font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;white-space:nowrap}
  .b-send{color:var(--green);background:var(--green-b)}.b-prep{color:var(--purple);background:var(--purple-b)}.b-kept{color:var(--gray);background:var(--gray-b)}.b-blocked{color:var(--gray);background:var(--gray-b)}
  .diffhint{font-size:10px;color:var(--faint);white-space:nowrap}
  .foot{margin-top:16px;color:var(--faint);font-size:11.5px}
  .empty{padding:24px;text-align:center;color:var(--faint)}
  h2{font-size:13px;margin:20px 0 8px}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 18px;padding:12px 14px}
  .fact{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--hair);padding:4px 0}.fact span{color:var(--muted)}
  .filters{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--hair)}.filters select{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);border-radius:6px;padding:4px 7px}
  .table{overflow:auto}.decision{display:grid;grid-template-columns:minmax(150px,1.4fr) 90px 105px minmax(110px,1fr) minmax(150px,1.2fr) 65px 80px 100px;gap:9px;padding:8px 12px;border-top:1px solid var(--hair);align-items:start}
  .decision.head{font-size:10px;color:var(--faint);text-transform:uppercase;border-top:0}.reason{color:var(--muted);font-size:11px}.tree{font:11px var(--mono);white-space:pre-wrap;padding:12px 14px;color:var(--muted)}
  .warn{border-left:3px solid var(--vscode-notificationsWarningIcon-foreground,#cca700);padding:10px 12px;background:var(--panel);margin-top:16px}
</style></head><body>
<div class="wrap">
  <h1>Prepared by Yuhi</h1>
  <div class="sub">Prepared locally for <b id="proj"></b> · written to <code id="outdir"></code> · <b>token counts are estimated</b></div>
  <h2>Overview</h2>
  <div class="card facts" id="overview"></div>
  <h2>Context reduction</h2>
  <div class="cards" id="cards"></div>
  <div class="stats" id="stats"></div>
  <h2>Sensitive data handling</h2>
  <div class="card facts" id="sensitive"></div>
  <h2>File decisions</h2>
  <div class="card">
    <div class="filters"><label for="filter">Filter</label><select id="filter"><option value="all">All files</option><option value="included">Included</option><option value="transformed">Transformed</option><option value="masked">Masked</option><option value="excluded">Excluded</option><option value="kept-local">Kept local</option><option value="unresolved">Unresolved high risk</option></select></div>
    <div class="table" id="list"></div>
  </div>
  <h2>What Claude Code receives</h2>
  <div class="card tree" id="tree"></div>
  <h2>Runtime access</h2>
  <div class="card facts" id="runtime"></div>
  <div class="warn"><b>Workspace boundary: advisory</b><br>Claude Code starts in a Yuhi Prepared Workspace. The agent may access files outside the Prepared Workspace if the runtime or user permits it. Yuhi does not prevent parent-directory, home-directory, or absolute-path access.</div>
  <div class="foot">Original files modified: 0 · OS sandbox: not enabled.<br><br>Estimated from the Prepared Workspace content. Actual model input usage may differ because agents add system prompts, tool output, cached context, and conversation history. No financial claim is made.</div>
</div>
<script nonce="${nonce}">
const DATA=${json};const vscode=acquireVsCodeApi();
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const nf=n=>Intl.NumberFormat().format(n);
const r=DATA.report;
const m=DATA.metrics;
document.getElementById("proj").textContent=DATA.project;
document.getElementById("outdir").textContent=DATA.outDir;
const pct=m.estimatedReductionPercent.toFixed(1);
const facts=(items)=>items.map(x=>'<div class="fact"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>').join("");
document.getElementById("overview").innerHTML=facts([
  ["Agent",DATA.agent],["Run ID",DATA.runId],["Preparation result",DATA.outcome],
  ["Initial context","Prepared by Yuhi"],["Original source files modified","0"],
  ["Workspace boundary",DATA.runtime.workspaceBoundary],["OS sandbox",DATA.runtime.osSandboxEnabled?"Enabled":"Not enabled"]
]);
let hero;
if(!r.hasData){hero='<div class="oc save"><div class="n">—</div><div class="t">Estimated Claude input avoided</div><div class="d">unavailable (no summarizable content)</div></div>';}
else if(r.tokensSaved>=0){hero='<div class="oc save"><div class="n">'+nf(r.tokensSaved)+'</div><div class="t">Estimated tokens avoided</div><div class="d">Estimated context reduction: '+pct+'%</div></div>';}
else{hero='<div class="oc save"><div class="n">+'+nf(-r.tokensSaved)+'</div><div class="t">Estimated Claude input INCREASED</div><div class="d">≈ '+Math.abs(pct)+'% more — summary larger than source</div></div>';}
document.getElementById("cards").innerHTML=
  hero+
  '<div class="oc before"><div class="n">'+nf(r.beforeTokens)+'</div><div class="t">Estimated input before</div><div class="d">estimated tokens</div></div>'+
  '<div class="oc after"><div class="n">'+nf(r.afterTokens)+'</div><div class="t">Estimated input after</div><div class="d">estimated tokens</div></div>';
document.getElementById("stats").innerHTML=
  '<span class="stat"><b>'+m.filesSentUnchanged+'</b> sent unchanged</span>'+
  '<span class="stat"><b>'+m.filesPreparedLocally+'</b> prepared locally</span>'+
  '<span class="stat"><b>'+m.filesSummarized+'</b> summarized locally</span>'+
  '<span class="stat"><b>'+m.filesPseudonymized+'</b> pseudonymized</span>'+
  '<span class="stat"><b>'+m.filesWithMaskedValues+'</b> files with masked values</span>'+
  '<span class="stat"><b>'+m.sensitiveValuesMasked+'</b> sensitive values masked</span>'+
  '<span class="stat"><b>'+m.preparedFilesModified+'</b> Prepared copies transformed</span>'+
  '<span class="stat"><b>'+m.filesKeptLocal+'</b> kept local</span>'+
  '<span class="stat"><b>'+m.filesExcluded+'</b> excluded</span>'+
  '<span class="stat safe">Original source files modified: '+m.originalSourceFilesModified+'</span>';
document.getElementById("sensitive").innerHTML=facts([
  ["Sensitive findings detected",String(m.sensitiveFindings)],
  ["Files containing sensitive findings",String(m.filesWithSensitiveFindings)],
  ["Sensitive values masked",String(m.sensitiveValuesMasked)],
  ["Files containing masked values",String(m.filesWithMaskedValues)],
  ["Sensitive files excluded",String(m.sensitiveFilesExcluded)],
  ["Files kept local",String(m.filesKeptLocal)],
  ["Unresolved high-risk findings",String(m.unresolvedHighRiskFindings)],
  ["Launch",m.unresolvedHighRiskFindings>0?"Blocked":"Allowed"]
]);
document.getElementById("runtime").innerHTML=facts([
  ["Start directory",DATA.runtime.startDirectory==="prepared-workspace"?"Prepared Workspace":DATA.runtime.startDirectory],
  ["Workspace instruction present",DATA.runtime.workspaceInstructionPresent?"Yes":"No"],
  ["Workspace boundary",DATA.runtime.workspaceBoundary],
  ["Filesystem enforcement",DATA.runtime.filesystemEnforcement==="none"?"Not enabled":DATA.runtime.filesystemEnforcement],
  ["OS sandbox",DATA.runtime.osSandboxEnabled?"Enabled":"Not enabled"],
  ["External-path access",DATA.runtime.externalPathAccessPossible?"May still be possible":"Not reported"]
]);
// action -> badge label/class
const B={allow:["Sent","b-send"],redact:["Prepared","b-prep"],"prepare-locally":["Prepared","b-prep"],
  "summarize-local":["Prepared","b-prep"],"metadata-only":["Kept","b-kept"],inject:["Runtime only","b-kept"],
  "local-only":["Kept local","b-kept"],ask:["Kept","b-kept"],block:["Excluded","b-blocked"]};
const badge=f=>{const b=B[f.action]||["Kept","b-kept"];let label=b[0];if(f.omitted&&f.action!=="block"&&b[1]!=="b-kept")label="Excluded";return '<span class="badge '+b[1]+'">'+label+'</span>';};
const list=document.getElementById("list");
const files=DATA.files.slice().sort((a,b)=>a.path.localeCompare(b.path));
const renderFiles=(selected)=>{
const visible=files.filter(f=>selected==="all"||selected==="included"&&f.included||selected==="transformed"&&f.transformed||selected==="masked"&&f.transformations.includes("masked")||selected==="excluded"&&f.omitted&&!["local-only","inject","ask","metadata-only"].includes(f.action)||selected==="kept-local"&&f.omitted&&["local-only","inject","ask","metadata-only"].includes(f.action)||selected==="unresolved"&&f.unresolvedHighRiskCount>0);
if(!visible.length){list.innerHTML='<div class="empty">No matching files in this run.</div>';return;}
list.innerHTML='<div class="decision head"><span>File</span><span>Sensitivity</span><span>Yuhi action</span><span>Rule</span><span>Reason</span><span>Included</span><span>Transformed</span><span>Claude receives</span></div>'+visible.map(f=>{
  const tk=f.omitted?'omitted':nf(f.beforeTokens)+' → '+nf(f.afterTokens);
  const file=f.diffable?'<button class="row diffable" data-p="'+esc(f.path)+'"><span class="fp">'+esc(f.path)+'</span><span class="diffhint">diff ↔</span></button>':'<span class="fp">'+esc(f.path)+'</span>';
  return '<div class="decision">'+file+'<span>'+esc(f.sensitivity)+'</span>'+badge(f)+'<span>'+esc(f.rule)+'<br><small>'+esc(f.classificationSource)+'</small></span><span class="reason">'+esc(f.reason)+'</span><span>'+(f.included?'Yes':'No')+'</span><span>'+(f.transformed?'Yes':'No')+'</span><span class="tk">'+esc(f.claudeReceives)+(f.transformations.length?' · '+esc(f.transformations.join(", ")):'')+'<br>'+tk+'</span></div>';
}).join("");};
renderFiles("all");
document.getElementById("filter").addEventListener("change",e=>renderFiles(e.target.value));
list.addEventListener("click",e=>{const row=e.target.closest(".diffable");if(row)vscode.postMessage({type:"diff",path:row.dataset.p});});
document.getElementById("tree").textContent=DATA.preparedTree.map(p=>"• "+p).join("\\n")||"No files included.";
</script></body></html>`;
}
