import type { WorkspaceManifest } from "@yuhi/shared";
import { createWorkspace } from "@yuhi/workspace";
import { computePlan } from "./plan.js";
import { buildPreview, type PreviewData } from "./preview.js";
import { saveSnapshot, snapshotFromPlan } from "./state.js";
import { buildPrepareContent } from "./route-executor.js";

export interface CreateForDirOptions {
  agent?: string;
  dryRun?: boolean;
  interactive: boolean;
}

export interface CreateForDirResult {
  manifest: WorkspaceManifest;
  treeDir: string;
  baseDir: string;
  warnings: string[];
  preview: PreviewData;
}

/** Create a workspace for a directory without launching any agent. */
export async function createWorkspaceForDir(
  dir: string,
  options: CreateForDirOptions,
): Promise<CreateForDirResult> {
  const plan = await computePlan(dir, {
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    interactive: options.interactive,
  });
  const { config } = plan.context;
  const res = createWorkspace({
    sourceRoot: plan.context.root,
    agent: plan.agentId,
    policyHash: plan.context.policyHash,
    decisions: plan.evaluation.decisions,
    scan: plan.scan,
    entropyThreshold: config.scan.entropy_threshold,
    keywords: config.scan.keywords,
    isGitRepo: plan.isGitRepo,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    preserveGit: config.workspace.preserve_git,
    prepareContent: buildPrepareContent(plan),
  });
  if (!options.dryRun) saveSnapshot(snapshotFromPlan(plan));
  return { ...res, preview: buildPreview(plan) };
}
