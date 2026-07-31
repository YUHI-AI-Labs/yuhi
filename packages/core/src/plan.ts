import type { DocumentInspector, PolicyEvaluation, ScanResult } from "@yuhi/shared";
import { scanRepo, isGitRepo } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";
import { loadContext, type YuhiContext } from "./context.js";

export interface PlanOptions {
  agent?: string;
  interactive: boolean;
  documentInspector?: DocumentInspector;
  deferDocumentInspection?: boolean;
  /** In-memory only; extracted document text must never enter persisted metadata. */
  onDocumentText?: (relpath: string, text: string) => void;
}

export interface Plan {
  context: YuhiContext;
  scan: ScanResult;
  evaluation: PolicyEvaluation;
  agentId: string;
  isGitRepo: boolean;
}

function explicitIncludeDirs(rules: YuhiContext["config"]["rules"]): Set<string> {
  const dirs = new Set<string>();
  for (const rule of rules) {
    for (const pattern of rule.match.paths ?? []) {
      const normalized = pattern.replaceAll("\\", "/").replace(/^!/, "").replace(/^\.\/+/, "");
      const top = normalized.split("/")[0];
      if (
        top &&
        top !== ".git" &&
        top !== ".yuhi" &&
        !top.includes("*") &&
        !top.includes("?")
      ) {
        dirs.add(top);
      }
    }
  }
  return dirs;
}

/** Load config, scan the repo, and resolve the policy. The shared core pipeline. */
export async function computePlan(dir: string, options: PlanOptions): Promise<Plan> {
  const context = await loadContext(dir);
  const { config, root } = context;

  const scan = await scanRepo(root, {
    largeFileBytes: config.workspace.large_file_bytes,
    entropyThreshold: config.scan.entropy_threshold,
    keywords: config.scan.keywords,
    explicitIncludeDirs: explicitIncludeDirs(config.rules),
    ...(options.documentInspector ? { documentInspector: options.documentInspector } : {}),
    ...(options.deferDocumentInspection ? { deferDocumentInspection: true } : {}),
    ...(options.onDocumentText ? { onDocumentText: options.onDocumentText } : {}),
  });

  const evaluation = resolvePolicy(
    {
      defaultAction: config.defaults.action,
      rules: config.rules,
      interactive: options.interactive,
    },
    scan.files.map((f) => ({
      relpath: f.relpath,
      findings: f.findings,
      inspection: f.inspection,
      ...(f.documentInspection ? { documentInspection: f.documentInspection } : {}),
    })),
  );

  const agentId = options.agent ?? config.defaults.agent;
  return { context, scan, evaluation, agentId, isGitRepo: isGitRepo(root) };
}
