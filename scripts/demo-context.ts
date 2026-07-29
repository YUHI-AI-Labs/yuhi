/**
 * Emit an enriched "AI context" JSON for a project, used to render the visual
 * Preview (Artifact + VS Code webview). Usage: tsx scripts/demo-context.ts <dir>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { computePlan, buildPreview, contextSavings } from "@yuhi/core";
import { redactText } from "@yuhi/scanner";
import { isVisibleToExternalAgent } from "@yuhi/shared";

const dir = process.argv[2] ?? "examples/demo";

const plan = await computePlan(dir, { interactive: false });
const preview = buildPreview(plan);
const sizeByPath = new Map(plan.scan.files.map((f) => [f.relpath, f]));

const files = plan.evaluation.decisions.map((d) => {
  const info = sizeByPath.get(d.relpath);
  const entry: Record<string, unknown> = {
    path: d.relpath,
    action: d.action,
    rule: d.ruleName,
    reason: d.reason,
    size: info?.size ?? 0,
    binary: info?.flags.isBinary ?? false,
    findings: d.findings.map((f) => ({
      detector: f.detector,
      severity: f.severity,
      description: f.description,
      maskedPreview: f.maskedPreview,
    })),
  };
  // Include content only for files an agent could actually see (allow/redact).
  if (info && !info.flags.isBinary && isVisibleToExternalAgent(d.action)) {
    try {
      const original = readFileSync(path.join(plan.scan.root, d.relpath), "utf8");
      if (original.length <= 4000) {
        entry.original = original;
        if (d.action === "redact") {
          entry.redacted = redactText(original, {
            entropyThreshold: plan.context.config.scan.entropy_threshold,
            keywords: plan.context.config.scan.keywords,
          }).redacted;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return entry;
});

const out = {
  project: path.basename(plan.scan.root),
  agent: plan.agentId,
  summary: preview.summary,
  filesInspected: preview.filesInspected,
  savings: contextSavings(plan),
  files,
};
process.stdout.write(JSON.stringify(out, null, 2));
