// Yuhi v0.3.1 OSS benchmark runner. Honest measurement, default config, no junk added.
// Does NOT modify Yuhi. Timing = wall clock + JSON localModelElapsedMs only.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const YUHI = join(REPO_ROOT, "apps/cli/dist/index.js");
// Scratch space for the benchmark clones. Machine-neutral by default so a run is
// reproducible anywhere; override with YUHI_BENCH_WORK to place it on another volume.
const WORK = process.env.YUHI_BENCH_WORK ?? join(tmpdir(), "yuhi-bench-run");
const TIMEOUT_MS = 150000;
const SRC_EXT = new Set(["ts","tsx","js","jsx","mjs","cjs","py","go","rs","java","rb","c","cc","cpp","h","hpp","cs","php","swift","kt","scala","vue","svelte"]);
const DATA_EXT = new Set(["csv","tsv","jsonl","parquet","xlsx","xls","db","sqlite","log"]);

const { repositories } = JSON.parse(readFileSync(join(HERE, "repositories.json"), "utf8"));
mkdirSync(WORK, { recursive: true });
mkdirSync(join(HERE, "badges"), { recursive: true });
mkdirSync(join(HERE, "logs"), { recursive: true });

const q = (c, o = {}) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"], ...o }).toString().trim(); } catch { return ""; } };

function yuhiRun(args, cwd) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("node", [YUHI, ...args], { cwd, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const timedOut = r.signal === "SIGTERM" || r.error?.code === "ETIMEDOUT";
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { wallMs, timedOut, code: r.status, json, stdoutLen: (r.stdout || "").length, stderr: (r.stderr || "").slice(-500) };
}

function metadata(dir) {
  const files = q(`find "${dir}" -type f -not -path '*/.git/*'`).split("\n").filter(Boolean);
  const total = files.length;
  let srcCount = 0, dataCount = 0, nb = 0, bytesText = 0;
  const flags = { dist: false, build: false, coverage: false, node_modules: false, vendor: false, notebooks: false, lockfile: false, data_dir: false };
  for (const f of files) {
    const rel = f.slice(dir.length + 1);
    const ext = (rel.split(".").pop() || "").toLowerCase();
    if (SRC_EXT.has(ext)) srcCount++;
    if (DATA_EXT.has(ext)) dataCount++;
    if (ext === "ipynb") nb++;
    if (/(^|\/)dist\//.test(rel)) flags.dist = true;
    if (/(^|\/)build\//.test(rel)) flags.build = true;
    if (/(^|\/)coverage\//.test(rel)) flags.coverage = true;
    if (/(^|\/)node_modules\//.test(rel)) flags.node_modules = true;
    if (/(^|\/)vendor\//.test(rel)) flags.vendor = true;
    if (/(^|\/)(data|datasets)\//i.test(rel)) flags.data_dir = true;
    if (/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock)$/.test(rel)) flags.lockfile = true;
  }
  if (nb > 0) flags.notebooks = true;
  const sizeMb = +(Number(q(`du -sm "${dir}" | cut -f1`)) - Number(q(`du -sm "${dir}/.git" 2>/dev/null | cut -f1`) || 0)).toFixed(0);
  const licenseFile = files.find(f => /\/(LICENSE|LICENCE|COPYING)(\.\w+)?$/i.test(f));
  let license = "unknown";
  if (licenseFile) { const h = readFileSync(licenseFile, "utf8").slice(0, 400); license = /MIT/.test(h) ? "MIT" : /Apache/.test(h) ? "Apache-2.0" : /BSD/.test(h) ? "BSD" : /GNU|GPL/.test(h) ? "GPL" : /ISC/.test(h) ? "ISC" : "other"; }
  // dominant source language
  const extCount = {};
  for (const f of files) { const e = (f.split(".").pop() || "").toLowerCase(); if (SRC_EXT.has(e)) extCount[e] = (extCount[e] || 0) + 1; }
  const lang = Object.entries(extCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
  return { total_files: total, source_files: srcCount, data_files: dataCount, notebooks: nb, size_mb: sizeMb, license, primary_language: lang, flags };
}

function routingBreakdown(previewJson, dir) {
  const decisions = previewJson?.decisions || [];
  const notDelivered = decisions.filter(d => ["local-only", "blocked", "keep-local", "block"].includes(d.route || d.action));
  const reasons = {};
  const paths = [];
  for (const d of notDelivered) {
    const key = d.rule || d.route || d.action || "unknown";
    reasons[key] = (reasons[key] || 0) + 1;
    const rel = d.relpath || d.path || "";
    let sz = 0; try { sz = execSync(`stat -f%z "${join(dir, rel)}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() | 0; } catch {}
    paths.push({ path: rel, bytes: sz, reason: key });
  }
  paths.sort((a, b) => b.bytes - a.bytes);
  const byAction = {};
  for (const d of decisions) { const a = d.route || d.action || "?"; byAction[a] = (byAction[a] || 0) + 1; }
  return { excluded_count: notDelivered.length, top_exclusion_reasons: reasons, largest_excluded_paths: paths.slice(0, 8), routes_summary: byAction };
}

const results = [];
const stamp = () => new Date().toISOString();
function save() {
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
  const cols = ["repository","commit","category","primary_language","repository_size_mb","original_files","source_files","prepared_files","excluded_files","reduction_rate","elapsed_seconds_cold","elapsed_seconds_warm_median","ollama_seconds_median","ollama_pct","timeout","error","secrets_blocked","documents_prepared","identifiers_transformed","large_files_excluded"];
  const csv = [cols.join(",")].concat(results.map(r => cols.map(c => {
    const v = r[c] ?? ""; const s = String(v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s;
  }).join(","))).join("\n");
  writeFileSync(join(HERE, "results.csv"), csv + "\n");
}

console.log(`[bench] ${repositories.length} repos, started ${stamp()}`);
for (const repo of repositories) {
  const slug = repo.name.replace(/\//g, "__");
  const dir = join(WORK, slug);
  const rec = { repository: repo.name, url: repo.url, category: repo.category, reason: repo.reason, started_at: stamp() };
  console.log(`\n[bench] === ${repo.name} (${repo.category}) ===`);
  try {
    rmSync(dir, { recursive: true, force: true });
    const tc0 = Date.now();
    execSync(`git clone --depth 1 -q "${repo.url}" "${dir}"`, { stdio: "ignore", timeout: 240000 });
    rec.clone_seconds = +((Date.now() - tc0) / 1000).toFixed(1);
    rec.commit = q(`git -C "${dir}" rev-parse HEAD`).slice(0, 12);
    Object.assign(rec, metadata(dir));
    rec.repository_size_mb = rec.size_mb; rec.original_files = rec.total_files;

    // init + preview (routing/exclusion breakdown, cheap)
    yuhiRun(["--json", "init"], dir);
    const prev = yuhiRun(["--json", "preview"], dir);
    if (prev.json) Object.assign(rec, routingBreakdown(prev.json, dir));

    // prepare x3 (cold + 2 warm); skip warm if cold times out/fails
    const runsWall = [], runsOllama = []; let firstJson = null, timeout = false, error = "";
    for (let i = 0; i < 3; i++) {
      const r = yuhiRun(["--json", "prepare"], dir);
      const pr = r.json?.preparationReport;
      writeFileSync(join(HERE, "logs", `${slug}.run${i}.json`), JSON.stringify({ wallMs: r.wallMs, timedOut: r.timedOut, code: r.code, report: pr || null, localModelElapsedMs: r.json?.localModelElapsedMs, localModelRequests: r.json?.localModelRequests, status: r.json?.status, stderr: r.stderr }, null, 2));
      if (r.timedOut) { timeout = true; runsWall.push(r.wallMs); break; }
      if (!r.json) { error = `no-json (code ${r.code}) ${r.stderr}`.slice(0, 120); break; }
      runsWall.push(r.wallMs); runsOllama.push(r.json.localModelElapsedMs || 0);
      if (!firstJson) firstJson = r.json;
    }
    const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    rec.elapsed_seconds_cold = runsWall.length ? +(runsWall[0] / 1000).toFixed(1) : null;
    rec.elapsed_seconds_warm_median = runsWall.length > 1 ? +(median(runsWall.slice(1)) / 1000).toFixed(1) : null;
    rec.ollama_seconds_median = runsOllama.length ? +(median(runsOllama) / 1000).toFixed(1) : null;
    const warmMs = rec.elapsed_seconds_warm_median ?? rec.elapsed_seconds_cold;
    rec.ollama_pct = (warmMs && rec.ollama_seconds_median != null) ? +((rec.ollama_seconds_median / warmMs) * 100).toFixed(0) : null;
    rec.timeout = timeout; rec.error = error;
    const pr = firstJson?.preparationReport;
    if (pr) {
      rec.prepared_files = pr.preparedArtifacts; rec.reduction_rate = pr.estimatedReductionPercent;
      rec.secrets_blocked = pr.secretsBlocked; rec.documents_prepared = pr.documentsPrepared;
      rec.identifiers_transformed = pr.identifiersTransformed; rec.large_files_excluded = pr.largeFilesExcluded;
      rec.excluded_files = (firstJson.filesExcluded || 0) + (firstJson.filesKeptLocal || 0);
      rec.workflow_state = firstJson.workflowState; rec.run_id = firstJson.runId;
      // badge from a real run
      if (firstJson.runId) {
        const b = spawnSync("node", [YUHI, "report", firstJson.runId, "--format", "svg"], { cwd: dir, timeout: 30000, encoding: "utf8" });
        if (b.status === 0 && b.stdout.includes("<svg")) { writeFileSync(join(HERE, "badges", `${slug}.svg`), b.stdout); rec.badge = `badges/${slug}.svg`; }
      }
    }
    rec.finished_at = stamp();
    console.log(`[bench] ${repo.name}: reduction=${rec.reduction_rate ?? "n/a"}% files=${rec.original_files} warm=${rec.elapsed_seconds_warm_median ?? rec.elapsed_seconds_cold}s ollama=${rec.ollama_pct ?? "?"}% timeout=${rec.timeout} ${rec.error}`);
  } catch (e) {
    rec.error = (rec.error || "") + " | " + String(e.message || e).slice(0, 160);
    rec.finished_at = stamp();
    console.log(`[bench] ${repo.name}: ERROR ${rec.error}`);
  }
  rmSync(dir, { recursive: true, force: true });
  results.push(rec); save();
}
console.log(`\n[bench] DONE ${stamp()} — ${results.length} repos, results.json/csv written`);
