import { YUHI_VERSION, sha256, type AuditRecord, type WorkspaceManifest } from "@yuhi/shared";
import type { Plan } from "./plan.js";

export interface AuditRecordInput {
  outcome: AuditRecord["outcome"];
  exitCode: number | null;
  durationMs: number | null;
  manifest: WorkspaceManifest | null;
}

/** Build a metadata-only audit record. Never includes file contents or secrets. */
export function buildAuditRecord(plan: Plan, input: AuditRecordInput): AuditRecord {
  const appliedRules = [
    ...new Set(
      plan.evaluation.decisions
        .map((d) => d.ruleName)
        .filter((r) => r !== "default"),
    ),
  ];
  const m = input.manifest;
  return {
    id: sha256(`${plan.scan.root}:${new Date().toISOString()}:${Math.random()}`).slice(0, 12),
    timestamp: new Date().toISOString(),
    yuhiVersion: YUHI_VERSION,
    policyHash: plan.context.policyHash,
    agent: plan.agentId,
    source: { pathHash: sha256(plan.scan.root).slice(0, 16), isGitRepo: plan.isGitRepo },
    workspaceId: m?.id ?? null,
    counts: {
      inspected: plan.scan.filesInspected,
      visible: m?.counts.visible ?? 0,
      transformed: m?.counts.transformed ?? 0,
      blocked: m?.counts.blocked ?? plan.evaluation.byAction.block.length,
      localOnly: m?.counts.localOnly ?? plan.evaluation.byAction["local-only"].length,
    },
    appliedRules,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    outcome: input.outcome,
  };
}
