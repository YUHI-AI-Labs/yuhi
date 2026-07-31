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
  /** Structural/safety reason a transform failed (drives the honest per-file status). */
  failureCategory?: string;
  inspectionStatus?: string;
  limitationShown?: boolean;
  documentStatus?: "inspected" | "unavailable" | "failed";
  extractionMethod?: "pdf-text" | "ocr" | "none";
  pageCount?: number;
  summaryStatus?: "created" | "rejected" | "unavailable";
  summaryRelpath?: string;
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
    pdfInspected?: number;
    ocrProcessed?: number;
    unverifiedDocuments?: number;
    documentSummariesCreated?: number;
    documentSummariesRejected?: number;
    documentContextBeforeTokens?: number;
    documentContextAfterTokens?: number;
    textDocumentsInspected?: number;
    agentHandoffCreated?: boolean;
    localModelProvider?: string;
    localModelName?: string;
    localModelRequests?: number;
    localModelSucceeded?: number;
    localModelFailed?: number;
    localModelInputChars?: number;
    localModelOutputChars?: number;
    localModelElapsedMs?: number;
    localModelMaxConcurrency?: number;
    localModelConfiguredParallelism?: number;
  };
  files: ReviewFile[];
  projectFiles: string[];
  metadataFiles: string[];
  preparedTree: string[];
  /**
   * Documents queued for background inspection that have not completed yet.
   * The review panel is a point-in-time snapshot rendered right after the fast
   * blocking phase, while PDF inspection continues in the background — so a
   * positive value here means "still working", NOT "failed". The panel uses it
   * to stay honest instead of claiming everything is already done.
   */
  backgroundDocumentsPending?: number;
}

export function renderSavingsHtml(data: ReviewData, _cspSource: string, nonce: string): string {
  const {
    localModelProvider: _localModelProvider,
    localModelName: _localModelName,
    ...publicAcceptance
  } = data.acceptance;
  const json = JSON.stringify({ ...data, acceptance: publicAcceptance }).replace(/</g, "\\u003c");
  // A PDF awaiting background inspection is "in progress", not a warning: it was
  // deferred on purpose so Claude Code can start immediately. Only files that
  // finished the fast phase still unverified (structural / binary passthrough)
  // are true warnings that should color the headline.
  const isPendingDocument = (file: ReviewFile): boolean =>
    file.fileType === "PDF" && file.included && !file.omitted && !file.documentStatus;
  const backgroundPending =
    data.backgroundDocumentsPending ?? data.files.filter(isPendingDocument).length;
  // Three honest buckets (never one scary "N not fully inspected"):
  //  - Background work: documents still being inspected (progress, not a warning).
  //  - Included unchanged: binaries / unsupported / non-sensitive files passed
  //    verbatim — informational, requires no action.
  //  - Needs your review: files kept on this computer for a safety decision — the
  //    ONLY bucket that asks the user to act, and the only one that colors the head.
  const includedUnchangedCount = data.files.filter(
    (file) => file.outcome === "included-unverified" && !isPendingDocument(file),
  ).length;
  const needsReviewCount = data.metrics.filesKeptLocal + data.metrics.filesExcluded;
  const launch = data.launchDecisionEnabled
    ? '<button class="button primary launchAction">Open with Claude Code</button>'
    : data.openClaudeHereEnabled
      ? '<button class="button primary openClaudeHere">Open Claude Code</button>'
    : "";
  const cancelLabel = data.launchDecisionEnabled ? "Cancel" : "Close";
  const recoveryActions = data.outcome === "Partial"
    ? '<button class="button primary" id="retryProtection">Retry protection</button>'
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
.sub{color:var(--muted);margin:0 0 14px}.card{border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}.card>.inside{padding:18px}.groups{display:grid;grid-template-columns:1fr 1fr}.group{padding:18px}.group+.group{border-left:1px solid var(--line)}.count{color:var(--muted);font-weight:400}.file-list{list-style:none;padding:0;margin:10px 0 0}.file-list li{display:flex;gap:9px;align-items:center;padding:6px 0;min-width:0}.file-list code{font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file-icon{color:var(--muted)}details.metadata{border-top:1px solid var(--line);padding:0 18px 14px}details summary{cursor:pointer;padding:13px 0;font-weight:700;color:var(--muted)}.note{font-size:12px;color:var(--muted)}
.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.metric b{display:block;font:700 24px var(--mono)}.metric span{color:var(--muted)}.metric.reduction{grid-column:span 2}.metric.reduction b{font-family:var(--sans)}.explanation{font-size:12px;margin-top:5px;color:var(--muted)}
.calm{margin-top:28px;padding:15px 17px;border-left:3px solid var(--warn);background:var(--panel);border-radius:4px 12px 12px 4px}.calm p{margin:0}.calm details summary{padding-bottom:3px}.calm .detail{color:var(--muted);font-size:13px}
.empty-state{padding:16px;color:var(--muted)}.toolbar{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px}.table{overflow:hidden}.row{display:grid;grid-template-columns:minmax(180px,1.5fr) 150px 140px minmax(180px,1fr);gap:14px;align-items:center;padding:11px 14px;border-top:1px solid var(--line);min-width:0}.row.head{position:sticky;top:0;background:var(--panel);z-index:1;border-top:0;color:var(--muted);font-size:11px;text-transform:uppercase}.path{font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.diff{border:0;background:none;color:var(--fg);text-align:left;padding:0;cursor:pointer}.why{color:var(--muted);font-size:13px}.badge{width:max-content;border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:12px}.advanced-row{padding:10px 14px;border-top:1px dashed var(--line);color:var(--muted);font-size:12px}
.advanced{margin-top:28px}.advanced .inside{padding:4px 18px 18px}.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 24px}.fact{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid var(--line)}.fact span{color:var(--muted)}.sticky{position:fixed;z-index:4;left:0;right:0;bottom:0;border-top:1px solid var(--line);background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px)}.sticky .inner{width:min(1160px,100%);margin:auto;padding:12px 28px;display:flex;justify-content:flex-end;gap:10px}
@media(max-width:800px){.wrap{padding:20px 16px 100px}.hero{padding:24px}h1{font-size:27px}.groups{grid-template-columns:1fr}.group+.group{border-left:0;border-top:1px solid var(--line)}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.row{grid-template-columns:minmax(150px,1fr) 130px 120px}.row>*:nth-child(4){display:none}.advanced-grid{grid-template-columns:1fr}.sticky .inner{padding:10px 16px}.metric.reduction{grid-column:1/-1}}
@media(max-width:520px){.summary-grid{grid-template-columns:1fr}.metric.reduction{grid-column:auto}.row{grid-template-columns:minmax(130px,1fr) 115px}.row>*:nth-child(3),.row>*:nth-child(4){display:none}.hero .actions{align-items:stretch}.hero .actions .button{width:100%}}
.checklist{list-style:none;padding:0;margin:2px 0 20px;display:grid;gap:8px}.checklist li{display:flex;gap:10px;align-items:center;font-size:15px}.checklist .ic{width:1.2em;text-align:center;flex:none;font-weight:800;font-size:15px}.checklist .ok{color:var(--good)}.checklist .warn{color:var(--warn)}.checklist .run{color:var(--vscode-charts-blue,#4aa0ff)}.checklist .muted{color:var(--muted)}.checklist .act{margin-left:auto;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:7px;padding:4px 12px;font:600 12px var(--sans);cursor:pointer}.checklist .act:hover{background:var(--soft)}.reassure{display:flex;gap:9px;align-items:flex-start;margin:0 0 18px;padding:11px 13px;border-radius:10px;background:var(--panel);border:1px solid var(--line)}.reassure .ic{color:var(--good);font-weight:800;flex:none}.reassure b{color:var(--fg)}.reassure span{color:var(--muted)}
@media(prefers-reduced-motion:no-preference){.spin{display:inline-block;animation:spin 1.2s linear infinite}}@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><main class="wrap">
<section class="hero">
 <div class="hero-top"><div class="eyebrow">YUHI</div><div class="ready">${data.outcome === "Partial" || data.outcome === "Failed" ? "ACTION NEEDED" : "READY"}</div></div><h1>${data.outcome === "Partial" || data.outcome === "Failed" ? "Preparation incomplete" : "Ready for Claude Code"}</h1>
 <p class="lead" id="heroLead"></p>
 <ul class="checklist" id="heroFacts"></ul>
 <div class="reassure" id="reassure" hidden></div>
 <p class="sub" id="localNote"></p>
 <div class="actions">${launch}${recoveryActions}<button class="button" id="review">Show details</button><button class="link" id="cancel">${cancelLabel}</button></div>
 <p class="sub">${data.outcome === "Partial" ? "Claude Code cannot start yet. Choose a recovery action below." : "Nothing has been sent yet."}</p>
</section>
<details class="card advanced" id="whatYuhiDid"><summary>What Yuhi did</summary><div class="inside"><p class="sub">A plain-language summary of preparation before Claude Code starts.</p><div class="advanced-grid" id="workSummary"></div></div></details>
<details class="card advanced" id="contextPreparation"><summary>Context preparation</summary><div class="inside"><p class="sub">Yuhi creates a local map of inspected documents before Claude Code starts.</p><div class="advanced-grid" id="contextSummary"></div><p class="note">Token counts are estimates only. Actual Claude usage may differ.</p></div></details>
<details class="card advanced" id="localAiActivity"><summary>Yuhi processing activity</summary><div class="inside"><p class="sub">Measured local preparation activity for this run only. Input content and generated responses are not stored in these metrics.</p><div class="advanced-grid" id="localAiSummary"></div></div></details>
<details class="card advanced" id="documentInspection"><summary>Document inspection</summary><div class="inside"><p class="sub">PDF inspection runs locally. Extracted text is used only for the security scan and is not stored or uploaded.</p><div id="documentSummary"></div><div id="documentFiles"></div></div></details>
<details class="card advanced" id="files"><summary>Files available to Claude Code and files staying local</summary><div class="inside"><h2 id="receiveTitle"></h2><p class="sub">This is the actual Prepared Workspace, not your original workspace.</p>
 <div class="card"><div class="groups"><div class="group"><h3>Project files <span class="count" id="projectCount"></span></h3><ul class="file-list" id="projectFiles"></ul></div>
 <div class="group"><h3>Result</h3><div id="fileResult" class="empty-state"></div></div></div>
 <details class="metadata"><summary id="metadataTitle"></summary><p class="note">Yuhi metadata supports review and audit. It is not part of your project source. These files are present in the Prepared Workspace and Claude Code may read them.</p><ul class="file-list" id="metadataFiles"></ul></details></div>
</div></details>
<aside class="calm" id="privacyDecision" hidden></aside>
<details class="card advanced"><summary>Preparation details</summary><div class="inside"><p class="sub">Technical preparation metrics.</p><div class="summary-grid" id="summary"></div></div></details>
<details class="card advanced"><summary>Technical details</summary><div class="inside"><p><b id="runtimeNotice"></b></p><div class="detail" id="runtimeExplanation"></div><div id="runtimeFacts"></div><div class="advanced-grid" id="advanced"></div><h3>Scanner and policy details</h3><div class="advanced-grid" id="scanner"></div><p class="note">Estimated context reduction is calculated from Prepared Workspace content. Actual agent usage may differ because of system prompts, tool output, conversation history, and caching. This is not a billing or cost-savings measurement.</p></div></details>
<details class="card advanced" id="fileDecisions"><summary>Full file decisions</summary><div class="inside"><p class="sub">Why each project file was included, changed, or withheld.</p><div class="card table"><div class="toolbar"><label for="filter">Show</label><select id="filter"><option value="all">All files</option><option value="included">Included</option><option value="transformed">Transformed</option><option value="excluded">Excluded</option><option value="kept">Kept local</option><option value="withheld">Not available to Claude</option></select></div><div id="decisions"></div></div></div></details>
</main>
<div class="sticky"><div class="inner"><button class="button" id="backToFiles">Back to files</button>${launch}<button class="link" id="cancelSticky">${cancelLabel}</button></div></div>
<script nonce="${nonce}">
const DATA=${json},vscode=acquireVsCodeApi(),m=DATA.metrics,r=DATA.report,a=DATA.acceptance;
const backgroundPending=${backgroundPending};
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const nf=n=>Intl.NumberFormat().format(n),pct=m.estimatedReductionPercent.toFixed(1);
const transformed=m.preparedFilesModified,included=DATA.projectFiles.length;
// A PDF still queued for background inspection is "in progress", not unverified.
const isPending=f=>f.fileType==="PDF"&&f.included&&!f.omitted&&!f.documentStatus;
const unverifiedIncluded=DATA.files.filter(f=>f.outcome==="included-unverified"&&!isPending(f));
// Files whose FINAL delivered bytes still contain identifiers (the final privacy
// gate flagged them). These are NOT "binary or unsupported" and must never be
// summarized as safely handled — they are delivered with a warning.
const identifierLeaks=unverifiedIncluded.filter(f=>f.failureCategory==="reidentification-risk"||f.failureCategory==="conflicting-identifiers");
const benignUnverified=unverifiedIncluded.filter(f=>!identifierLeaks.includes(f));
const documentFiles=DATA.files.filter(f=>f.fileType==="PDF");
// Human-readable file type: never surface internal tokens like "XLSX"/"Unknown".
const typeLabel=t=>{const k=String(t||"").toUpperCase();return k==="XLSX"?"Excel workbook":k==="CSV"?"CSV table":k==="TSV"?"TSV table":k==="PDF"?"PDF document":k==="TEXT"?"Text file":k==="BINARY"?"Binary file":"Document"};
// Plain-language status for a file included without a verified transform.
const warnStatus=f=>isPending(f)?"Inspecting in the background":f.fileType==="BINARY"?"Binary file · included unchanged":(f.failureCategory==="structural")?"Structure could not be parsed · included unchanged":(f.failureCategory==="conflicting-identifiers")?"Identifiers could not be separated · included unchanged":(f.failureCategory==="reidentification-risk")?"Could not verify de-identification · included unchanged":"Not fully inspected · included unchanged";
const environmentPrepared=DATA.files.some(f=>[
  "yuhi:environment-sanitized-copy",
  "sanitize-environment-files",
  "yuhi:credential-sanitized-copy",
  "sanitize-credential-files",
].includes(f.rule));
document.getElementById("runtimeNotice").textContent="Yuhi prepared the initial context. This is an advisory workspace boundary, not an OS-level sandbox.";
document.getElementById("runtimeExplanation").textContent="Claude Code starts in the Prepared Workspace. Yuhi denies reads from known sensitive locations (home directory, /tmp, /private/tmp) on a best-effort basis, but user-approved external paths may still be accessible — Yuhi does not provide OS-level isolation.";
const withheld=m.filesExcluded+m.filesKeptLocal;
document.getElementById("heroLead").textContent=DATA.outcome==="Partial"?"Yuhi needs your choice before Claude Code can start.":"Yuhi prepared everything it safely could. You can continue now.";
const li=(cls,ic,text,act)=>'<li><span class="ic '+cls+'" aria-hidden="true">'+ic+'</span><span>'+text+'</span>'+(act||'')+'</li>';
document.getElementById("heroFacts").innerHTML=DATA.outcome==="Partial"
  ? li("ok","✓",included+" "+(included===1?"file is":"files are")+" ready")+li("warn","⚠",withheld+" need your attention")
  : [
      li("ok","✓",included+" project "+(included===1?"file":"files")+" ready for Claude Code"),
      // Only claim "handled/verified" when the FINAL-artifact gate found no surviving
      // identifier. A single leak makes both claims false — never show them then.
      ...(m.sensitiveValuesMasked>0&&identifierLeaks.length===0?[li("ok","✓","Sensitive values handled")]:[]),
      ...(transformed>0&&identifierLeaks.length===0?[li("ok","✓","Transformed copies verified")]:[]),
      ...(environmentPrepared?[li("ok","✓","Runtime configuration preserved")]:[]),
      // Honest, prominent warning when a delivered file still contains identifiers.
      ...(identifierLeaks.length?[li("warn","⚠",identifierLeaks.length+" "+(identifierLeaks.length===1?"file":"files")+" could NOT be fully de-identified — delivered with a warning; review before sharing",'<button type="button" class="act" id="showWithheld">Review file decisions ›</button>')]:[]),
      // Background work — progress, not a warning.
      ...(backgroundPending>0?[li("run",'<span class="spin">◐</span>',"Background work · "+backgroundPending+" document"+(backgroundPending===1?"":"s")+" being inspected")]:[]),
      // Included unchanged — binaries / unsupported / non-sensitive files passed
      // verbatim. Informational (neutral), never a warning, no action needed.
      ...(benignUnverified.length?[li("muted","•","Included unchanged · "+benignUnverified.length+" binary or unsupported "+(benignUnverified.length===1?"file":"files"))]:[]),
      // Excluded by recommendation — kept on this computer for safety. Informational,
      // NOT a blocker: launch proceeds; the user may include them from the review list.
       ...(withheld>0?[li("warn","⚠",withheld+" "+(withheld===1?"file":"files")+" excluded by recommendation",'<button type="button" class="act" id="showWithheld">Review file decisions ›</button>')]:[]),
    ].join("");
// The one line that answers "can I open Claude Code now?".
const reassure=document.getElementById("reassure");
if(DATA.outcome!=="Partial"){
  reassure.hidden=false;
  reassure.innerHTML='<span class="ic" aria-hidden="true">✓</span><span><b>Safe to start now.</b> '+(backgroundPending>0?"Document inspection keeps running in the background after Claude Code opens — you do not need to wait.":"Nothing is sent anywhere; Claude Code opens in the local Prepared Workspace.")+'</span>';
}
document.getElementById("localNote").textContent=DATA.outcome==="Partial"||DATA.outcome==="Failed"?"Review the items that need attention to continue.":identifierLeaks.length?identifierLeaks.length+" "+(identifierLeaks.length===1?"file":"files")+" could not be fully de-identified and "+(identifierLeaks.length===1?"is":"are")+" delivered with a warning — open the review list and check before sharing.":withheld>0?"Claude Code can start now. "+withheld+" "+(withheld===1?"file was":"files were")+" excluded by recommendation — include from the review list if the task needs "+(withheld===1?"it":"them")+".":benignUnverified.length?"Binary and unsupported files are included unchanged; nothing sensitive was detected in them.":"Your workspace is ready.";
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
document.getElementById("workSummary").innerHTML=facts([
  ["Project files inspected",String(m.filesInspected)],
  ["Files available to Claude Code",String(included)],
  ["Files transformed locally",String(transformed)],
  ["Sensitive values handled",String(m.sensitiveValuesMasked)],
  ["Files staying on this computer",String(withheld)],
  ["Original files modified","0"],
]);
const restricted=DATA.files.filter(f=>f.sensitivity==="Restricted"),limited=DATA.files.filter(f=>f.limitationShown),box=document.getElementById("privacyDecision");
const pdfInspected=a.pdfInspected??0,ocrProcessed=a.ocrProcessed??0,unverifiedDocuments=a.unverifiedDocuments??0;
const summariesCreated=a.documentSummariesCreated??0,summariesRejected=a.documentSummariesRejected??0,documentBefore=a.documentContextBeforeTokens??0,documentAfter=a.documentContextAfterTokens??0,textDocuments=a.textDocumentsInspected??0,handoffCreated=a.agentHandoffCreated??false;
const documentReduction=documentBefore>0?Math.max(0,Math.round((documentBefore-documentAfter)/documentBefore*1000)/10):0;
document.getElementById("contextSummary").innerHTML=facts([["Agent handoff",handoffCreated?"Ready":"Not available"],["Documents inspected",String(pdfInspected+ocrProcessed+textDocuments)],["Text documents prepared",String(textDocuments)],["Context summaries created",String(summariesCreated)],["Summaries rejected by verification",String(summariesRejected)],["Estimated original document context",documentBefore.toLocaleString()+" tokens"],["Estimated prepared document context",documentAfter.toLocaleString()+" tokens"],["Estimated context reduction",documentReduction.toFixed(1)+"%"]]);
const modelRequests=a.localModelRequests??0,modelElapsed=a.localModelElapsedMs??0;
document.getElementById("localAiSummary").innerHTML=facts([["Local processing requests",String(modelRequests)],["Configured parallelism",String(a.localModelConfiguredParallelism??0)],["Peak parallel requests",String(a.localModelMaxConcurrency??0)],["Successful requests",String(a.localModelSucceeded??0)],["Failed requests",String(a.localModelFailed??0)],["Input processed",(a.localModelInputChars??0).toLocaleString()+" characters"],["Output generated",(a.localModelOutputChars??0).toLocaleString()+" characters"],["Total processing time",(modelElapsed/1000).toFixed(1)+" seconds"],["Average per request",modelRequests>0?(modelElapsed/modelRequests/1000).toFixed(1)+" seconds":"0.0 seconds"]]);
document.getElementById("documentSummary").innerHTML=facts([["PDF text extraction completed",String(pdfInspected)],["PDFs scanned with OCR",String(ocrProcessed)],["PDFs not fully inspected",String(unverifiedDocuments)]]);
document.getElementById("documentFiles").innerHTML=documentFiles.length
  ? documentFiles.map(f=>'<div class="advanced-row"><b>'+esc(f.path)+'</b>'+facts([
      ["Inspection",f.extractionMethod==="pdf-text"?"PDF text extraction":f.extractionMethod==="ocr"?"OCR":isPending(f)?"Running in the background":"Unavailable"],
      ["Result",f.documentStatus==="inspected"?"Completed":f.documentStatus==="failed"?"Failed":isPending(f)?"Inspecting — you can start Claude Code now":"Not fully inspected"],
       ["Security scan",f.findingCount>0?f.findingCount+" metadata-safe finding(s)":"No issues detected"],
       ["Summary",f.summaryStatus==="created"?"Generated locally":f.summaryStatus==="rejected"?"Rejected by security verification":f.summaryStatus==="unavailable"?"Local model unavailable":"Not created"],
       ["Context location",f.summaryRelpath??"Not available"],
       ["Claude receives",f.claudeReceives==="No"?"Nothing":f.outcome==="included-unverified"?"Original file with warning":"Original PDF"],
    ])+'</div>').join("")
  : '<p class="note">'+(pdfInspected+ocrProcessed+unverifiedDocuments>0?"Document details are unavailable for this older run.":"No PDF documents were found in this run.")+'</p>';
const environmentFiles=DATA.files.filter(f=>[
  "yuhi:environment-sanitized-copy",
  "sanitize-environment-files",
  "yuhi:credential-sanitized-copy",
  "sanitize-credential-files",
].includes(f.rule));
// Bug 3: say WHAT was detected (in plain terms), from the finding categories.
const DETECTED_LABELS={"direct-identifier-column":"Direct identifiers (names / IDs)","education-performance":"Grades / performance","health":"Health data","salary":"Salary","disciplinary":"Disciplinary records","email":"Email addresses","phone":"Phone numbers","student-id":"Student IDs","employee-id":"Employee IDs","national-id":"National IDs","bank-account":"Bank accounts","credential":"Credentials","access-token":"Access tokens","private-key":"Private keys","malformed-sensitive-table":"Sensitive tabular data"};
const detectedLabels=f=>{const keys=Object.keys(f.findingCategoryCounts||{});const labels=[...new Set(keys.map(k=>DETECTED_LABELS[k]||k))];return labels.length?labels.join(", "):"Sensitive data";};
// Bug 4: expose the concrete verification-failure reason for a kept-local file.
const failureReasonText=f=>{switch(f.failureCategory){case "conflicting-identifiers":return "Identifier mapping conflict — two rows' identifiers pointed to different people";case "reidentification-risk":return "Verification mismatch — the transformed output did not pass Yuhi's exact-output privacy rescan";case "structural":return "Unsupported table/spreadsheet structure — Yuhi could not parse it safely (e.g. merged cells, formulas)";case "unresolved-secret":return "Unresolved credential detected in the file";default:return f.fileType==="PDF"?"No verified local PDF inspection is available":"Unknown verification failure";}};
const limitationDetails=()=>limited.map(f=>"<p><b>"+esc(f.path)+"</b></p>"+facts([["Type",typeLabel(f.fileType)],["Detected",detectedLabels(f)],["Status","Transformation verification failed"],["Reason",failureReasonText(f)],["Claude receives","Nothing"]])).join("");
const unverifiedDetails=()=>unverifiedIncluded.map(f=>"<p><b>"+esc(f.path)+"</b></p>"+facts([["Type",typeLabel(f.fileType)],["Status",warnStatus(f)],["Claude receives","Original file"],["Action","Included with warning"]])).join("");
if(DATA.outcome==="Partial"){box.hidden=false;box.innerHTML="<p><b>Some files need attention.</b></p><p>Yuhi kept them on this computer. Continue with the files that are ready, or open details to learn more.</p><details><summary>Technical reason</summary>"+facts([["Malformed tables",String(a.malformedTables)],["Unverified transformations",String(a.unverifiedTransformations)],["Files requiring attention",String((a.unsupportedOrUnverifiedFiles??0)+(a.restrictedUnresolvedFiles??0))],["Raw fallback used","No"]])+limitationDetails()+"</details>"}
else if(withheld>0){box.hidden=false;box.innerHTML="<p><b>Excluded by recommendation · "+withheld+" "+(withheld===1?"file":"files")+"</b></p><p>Yuhi recommends keeping "+(withheld===1?"this file":"these files")+" on this computer because it could not verifiably de-identify "+(withheld===1?"it":"them")+". This does not block launch — Claude Code starts with everything else. You can include "+(withheld===1?"it":"any of them")+" from the list below.</p>"+facts([["Files excluded by recommendation",String(withheld)],["Claude receives","Nothing from these files"]])+"<details><summary>Why "+(withheld===1?"is this file":"are these files")+" excluded?</summary>"+limitationDetails()+"</details>"}
else if(unverifiedIncluded.length){box.hidden=false;box.innerHTML="<p><b>Included unchanged · "+unverifiedIncluded.length+" binary or unsupported "+(unverifiedIncluded.length===1?"file":"files")+"</b></p><p>No action needed. Yuhi found nothing sensitive to transform in "+(unverifiedIncluded.length===1?"this file":"these files")+", so "+(unverifiedIncluded.length===1?"it was":"they were")+" passed to Claude Code unchanged.</p>"+facts([["Prepared files",String(included)],["Transformed copies",String(transformed)],["Credential values kept out",environmentPrepared?"Yes":"None detected"],["Included unchanged",String(unverifiedIncluded.length)]])+"<details><summary>Which files</summary>"+unverifiedDetails()+"</details>"}
else if(environmentFiles.length){box.hidden=false;box.innerHTML="<p><b>Credential configuration prepared locally</b></p><p>The Prepared Workspace does not contain the original credential values. An agent may still read credentials from its runtime environment if the user or runtime provides them.</p>"+facts([["Credential values","Not included in Prepared Workspace"],["Non-sensitive configuration","Included"],["Prepared copy","Created"],["Post-transformation scan","Passed"]])}
else if(restricted.length){box.hidden=false;box.innerHTML="<p><b>Restricted tabular data transformed locally</b></p>"+facts([["Entities pseudonymized",String(a.entitiesPseudonymized)],["Identifier columns transformed",String(a.identifierColumnsTransformed)],["Analytical columns preserved",String(a.analyticalColumnsPreserved)],["Post-transformation scan",a.postTransformScanPassed?"Passed":"Failed"],["Raw fallback used","No"],["Original source modified","No"],["Claude receives","Verified transformed copy"]])}
document.getElementById("runtimeFacts").innerHTML=facts([["Starts in","Prepared Workspace"],["Workspace boundary",DATA.runtime.workspaceBoundary==="enforced"?"Enforced":"Advisory"],["Filesystem enforcement",DATA.runtime.filesystemEnforcement==="claude-code-sandbox"?"Claude Code sandbox":"Not enabled"],["OS sandbox",DATA.runtime.osSandboxEnabled?"Enabled":"Not enabled"],["External-path access",DATA.runtime.externalPathAccessPossible?"May still be possible":"Blocked by policy"]]);
const action=f=>f.outcome==="included-unverified"?"Included with warning":f.outcome==="local-only-unsupported"?"File kept local":f.outcome==="local-only-unverified"?"Restricted workbook kept local":f.outcome==="excluded-by-user"?"Excluded by user":f.outcome==="excluded-by-policy"?"Excluded by policy":f.omitted?(["local-only","inject","ask","metadata-only"].includes(f.action)?"Kept local":"Excluded"):f.transformations.includes("aggregated")?"Aggregated locally":f.transformations.includes("pseudonymized")?"Pseudonymized locally":f.transformations.includes("masked")?"Masked locally":f.transformations.includes("summarized")?"Summarized locally":"Included unchanged";
const receive=f=>f.claudeReceives==="No"?"Nothing":f.transformations.includes("aggregated")?"Aggregated copy":f.transformations.includes("pseudonymized")?"Pseudonymized copy":f.transformed?"Prepared copy":"Unchanged";
const files=DATA.files.slice().sort((a,b)=>a.path.localeCompare(b.path)),decisions=document.getElementById("decisions");
function render(selected){const shown=files.filter(f=>selected==="all"||selected==="included"&&f.included||selected==="transformed"&&f.transformed||selected==="excluded"&&f.omitted&&!["local-only","inject","ask","metadata-only"].includes(f.action)||selected==="kept"&&f.omitted&&["local-only","inject","ask","metadata-only"].includes(f.action)||selected==="withheld"&&f.omitted);if(!shown.length){decisions.innerHTML='<div class="empty-state">No matching files.</div>';return}decisions.innerHTML='<div class="row head"><span>File</span><span>Yuhi action</span><span>Claude receives</span><span>Why</span></div>'+shown.map(f=>{const p='<span class="path" title="'+esc(f.path)+'">'+esc(f.path)+'</span>';return '<div class="row">'+(f.diffable?'<button class="diff" data-p="'+esc(f.path)+'">'+p+'</button>':p)+'<span class="badge">'+action(f)+'</span><span>'+receive(f)+'</span><span class="why">'+esc(f.reason)+'</span></div>'}).join("")}
render("all");document.getElementById("filter").addEventListener("change",e=>render(e.target.value));decisions.addEventListener("click",e=>{const row=e.target.closest(".diff");if(row)vscode.postMessage({type:"diff",path:row.dataset.p})});
document.getElementById("advanced").innerHTML=facts([["Preparation result",DATA.outcome],["Run ID",DATA.runId],["Prepared output",DATA.outDir],["Project files inspected",String(m.filesInspected)],["Project files included",String(included)],["Generated Yuhi metadata files",String(DATA.metadataFiles.length)],["Estimated tokens before",String(r.beforeTokens)],["Estimated tokens after",String(r.afterTokens)]]);
const noFindings=m.sensitiveFindings===0?"No sensitive findings detected":m.sensitiveFindings+" sensitive findings detected";
const noWithheld=m.filesExcluded===0&&m.filesKeptLocal===0?"No files were withheld":m.filesExcluded+" excluded · "+m.filesKeptLocal+" kept local";
document.getElementById("scanner").innerHTML='<p>'+esc(noFindings)+'</p><p>'+esc(noWithheld)+'</p>'+facts([["Files containing findings",String(m.filesWithSensitiveFindings)],["Files containing masked values",String(m.filesWithMaskedValues)],["Unresolved high-risk findings",String(m.unresolvedHighRiskFindings)]]);
const send=t=>vscode.postMessage({type:t});document.querySelectorAll(".launchAction").forEach(b=>b.addEventListener("click",()=>send("launch")));document.querySelectorAll(".openClaudeHere").forEach(b=>b.addEventListener("click",()=>send("openClaudeHere")));document.querySelectorAll("#cancel,#cancelSticky").forEach(b=>b.addEventListener("click",()=>send("cancel")));document.getElementById("review").addEventListener("click",()=>{document.getElementById("files").open=true;document.getElementById("files").scrollIntoView()});document.getElementById("backToFiles").addEventListener("click",()=>{document.getElementById("files").open=true;document.getElementById("files").scrollIntoView()});
const showWithheldFiles=()=>{const s=document.getElementById("filter");if(s)s.value="withheld";render("withheld");const d=document.getElementById("fileDecisions");if(d){d.open=true;d.scrollIntoView()}};const swBtn=document.getElementById("showWithheld");if(swBtn){swBtn.addEventListener("click",showWithheldFiles);swBtn.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();showWithheldFiles()}})}
document.getElementById("retryProtection")?.addEventListener("click",()=>send("retryProtection"));
</script></body></html>`;
}
