/**
 * "Context Savings" review webview. Shows Original vs Prepared *estimated* tokens,
 * the reduction, which files were excluded / summarized / had sensitive values
 * masked, and the invariant "Source files modified: 0". Each file offers an
 * Original ↔ Prepared diff (handled by the extension via vscode.diff).
 *
 * Vocabulary is deliberately plain: no processor/provider jargon. Token counts are
 * always labelled "Estimated".
 */

export interface ReviewFile {
  path: string;
  action: string;
  status: string;
  omitted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** true when a prepared copy exists that can be diffed against the original. */
  diffable: boolean;
}

export interface ReviewData {
  project: string;
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
  files: ReviewFile[];
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
</style></head><body>
<div class="wrap">
  <h1>Context Savings</h1>
  <div class="sub">Prepared locally for <b id="proj"></b> · written to <code id="outdir"></code> · <b>token counts are estimated</b></div>
  <div class="cards" id="cards"></div>
  <div class="stats" id="stats"></div>
  <div class="card">
    <div class="ch"><span>Per-file</span><span>Estimated tokens · before → after</span></div>
    <div class="list" id="list"></div>
  </div>
  <div class="foot">Yuhi prepares files on your machine before anything is sent to Claude — it is not a sandbox (an agent you launch still has network &amp; OS access). Your original files are never modified.<br><br>Estimated tokens. Actual usage and billing depend on the selected AI product, provider behavior, caching, and pricing.</div>
</div>
<script nonce="${nonce}">
const DATA=${json};const vscode=acquireVsCodeApi();
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const nf=n=>Intl.NumberFormat().format(n);
const r=DATA.report;
document.getElementById("proj").textContent=DATA.project;
document.getElementById("outdir").textContent=DATA.outDir;
const pct=Math.round(r.percentReduction*100);
let hero;
if(!r.hasData){hero='<div class="oc save"><div class="n">—</div><div class="t">Estimated Claude input avoided</div><div class="d">unavailable (no summarizable content)</div></div>';}
else if(r.tokensSaved>=0){hero='<div class="oc save"><div class="n">'+nf(r.tokensSaved)+'</div><div class="t">Estimated Claude input avoided</div><div class="d">≈ '+pct+'% fewer input tokens</div></div>';}
else{hero='<div class="oc save"><div class="n">+'+nf(-r.tokensSaved)+'</div><div class="t">Estimated Claude input INCREASED</div><div class="d">≈ '+Math.abs(pct)+'% more — summary larger than source</div></div>';}
document.getElementById("cards").innerHTML=
  hero+
  '<div class="oc before"><div class="n">'+nf(r.beforeTokens)+'</div><div class="t">Estimated input before</div><div class="d">estimated tokens</div></div>'+
  '<div class="oc after"><div class="n">'+nf(r.afterTokens)+'</div><div class="t">Estimated input after</div><div class="d">estimated tokens</div></div>';
document.getElementById("stats").innerHTML=
  '<span class="stat"><b>'+r.filesSummarized+'</b> summarized locally</span>'+
  '<span class="stat"><b>'+r.filesExcluded+'</b> excluded</span>'+
  '<span class="stat"><b>'+r.sensitiveMasked+'</b> with sensitive values masked</span>'+
  '<span class="stat safe">Source files modified: '+r.sourceModified+'</span>';
// action -> badge label/class
const B={allow:["Sent","b-send"],redact:["Prepared","b-prep"],"prepare-locally":["Prepared","b-prep"],
  "summarize-local":["Prepared","b-prep"],"metadata-only":["Kept","b-kept"],inject:["Runtime only","b-kept"],
  "local-only":["Kept local","b-kept"],ask:["Kept","b-kept"],block:["Excluded","b-blocked"]};
const badge=f=>{const b=B[f.action]||["Kept","b-kept"];let label=b[0];if(f.omitted&&f.action!=="block"&&b[1]!=="b-kept")label="Excluded";return '<span class="badge '+b[1]+'">'+label+'</span>';};
const list=document.getElementById("list");
const files=DATA.files.slice().sort((a,b)=>a.path.localeCompare(b.path));
if(!files.length){list.innerHTML='<div class="empty">No files in this run.</div>';}
else{list.innerHTML=files.map(f=>{
  const tk=f.omitted?'omitted':nf(f.beforeTokens)+' → '+nf(f.afterTokens);
  const hint=f.diffable?'<span class="diffhint">diff ↔</span>':'';
  return '<button class="row '+(f.diffable?'diffable':'')+'" data-p="'+esc(f.path)+'" '+(f.diffable?'':'disabled')+'>'+
    '<span class="fp">'+esc(f.path)+'</span>'+badge(f)+'<span class="tk">'+tk+'</span>'+hint+'</button>';
}).join("");}
list.addEventListener("click",e=>{const row=e.target.closest(".row.diffable");if(row)vscode.postMessage({type:"diff",path:row.dataset.p});});
</script></body></html>`;
}
