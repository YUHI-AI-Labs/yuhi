import type { PolicyEvaluation, ScanResult } from "@yuhi/shared";
import { scanRepo, isGitRepo } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";
import { loadContext, type YuhiContext } from "./context.js";

export interface PlanOptions {
  agent?: string;
  interactive: boolean;
}

export interface Plan {
  context: YuhiContext;
  scan: ScanResult;
  evaluation: PolicyEvaluation;
  agentId: string;
  isGitRepo: boolean;
}

/** Load config, scan the repo, and resolve the policy. The shared core pipeline. */
export async function computePlan(dir: string, options: PlanOptions): Promise<Plan> {
  const context = await loadContext(dir);
  const { config, root } = context;

  const scan = scanRepo(root, {
    largeFileBytes: config.workspace.large_file_bytes,
    entropyThreshold: config.scan.entropy_threshold,
    keywords: config.scan.keywords,
  });

  const evaluation = resolvePolicy(
    {
      defaultAction: config.defaults.action,
      rules: config.rules,
      interactive: options.interactive,
    },
    scan.files.map((f) => ({ relpath: f.relpath, findings: f.findings })),
  );

  const agentId = options.agent ?? config.defaults.agent;
  return { context, scan, evaluation, agentId, isGitRepo: isGitRepo(root) };
}
