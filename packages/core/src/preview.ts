import {
  isVisibleToExternalAgent,
  type Action,
  type FileDecision,
} from "@yuhi/shared";
import type { Plan } from "./plan.js";

export interface PreviewSummary {
  visible: number;
  transformed: number;
  blocked: number;
  localOnly: number;
  symlinksSkipped: number;
  bytesVisible: number;
}

export interface PreviewData {
  agent: string;
  sourcePath: string;
  isGitRepo: boolean;
  filesInspected: number;
  decisions: FileDecision[];
  byAction: Record<Action, FileDecision[]>;
  summary: PreviewSummary;
  warnings: string[];
}

/** Build the preview — the signature "what will the AI see?" view. */
export function buildPreview(plan: Plan): PreviewData {
  const sizeByPath = new Map(plan.scan.files.map((f) => [f.relpath, f.size]));
  const decisions = plan.evaluation.decisions;

  let bytesVisible = 0;
  let visible = 0;
  let transformed = 0;
  for (const d of decisions) {
    if (isVisibleToExternalAgent(d.action)) {
      visible++;
      bytesVisible += sizeByPath.get(d.relpath) ?? 0;
      if (d.action === "redact") transformed++;
    }
  }

  const symlinksSkipped = plan.scan.files.filter((f) => f.flags.isSymlink).length;

  return {
    agent: plan.agentId,
    sourcePath: plan.scan.root,
    isGitRepo: plan.isGitRepo,
    filesInspected: plan.scan.filesInspected,
    decisions,
    byAction: plan.evaluation.byAction,
    summary: {
      visible,
      transformed,
      blocked: plan.evaluation.byAction.block.length,
      localOnly: plan.evaluation.byAction["local-only"].length,
      symlinksSkipped,
      bytesVisible,
    },
    warnings: plan.scan.warnings,
  };
}

/** Explain a single file (find its decision within a plan). */
export function explainFromPlan(plan: Plan, relpath: string): FileDecision | null {
  const norm = relpath.replace(/\\/g, "/").replace(/^\.\//, "");
  return plan.evaluation.decisions.find((d) => d.relpath === norm) ?? null;
}
