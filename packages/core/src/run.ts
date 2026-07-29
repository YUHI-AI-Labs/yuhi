import { YuhiError, type WorkspaceManifest } from "@yuhi/shared";
import {
  buildAdapter,
  buildChildEnv,
  defaultEnvPassthrough,
  missingPassthrough,
  runCommand,
} from "@yuhi/agents";
import { createWorkspace, cleanWorkspace } from "@yuhi/workspace";
import { writeAudit, pruneAudit } from "@yuhi/audit";
import { computePlan, type Plan } from "./plan.js";
import { buildPreview, type PreviewData } from "./preview.js";
import { buildAuditRecord } from "./audit-record.js";
import { saveSnapshot, snapshotFromPlan } from "./state.js";
import { collectInjectedEnv } from "./inject.js";
import { buildPrepareContent } from "./route-executor.js";

export interface RunHooks {
  /** Called with the preview + manifest right before launching (for rendering). */
  onBeforeLaunch?: (preview: PreviewData, manifest: WorkspaceManifest) => void | Promise<void>;
  /** Ask whether to delete the workspace after the run (cleanup: prompt). */
  confirmCleanup?: (manifest: WorkspaceManifest) => Promise<boolean>;
  /** Called when required allow-listed env vars are missing (friendly warning). */
  onMissingEnv?: (agent: string, missing: string[]) => void;
  /** Called with the NAMES (never values) injected via the Runtime-only route. */
  onInjected?: (keys: string[], sources: string[]) => void;
}

export interface RunOptions {
  agent?: string;
  forwardedArgs: string[];
  interactive: boolean;
  cleanup?: "prompt" | "always" | "never";
  dryRun?: boolean;
  hooks?: RunHooks;
}

export interface RunResult {
  manifest: WorkspaceManifest;
  exitCode: number | null;
  workspaceKept: boolean;
  preview: PreviewData;
}

/**
 * The full `yuhi run <agent>` pipeline:
 *   config → scan → policy → workspace → preview → launch → audit → cleanup.
 */
export async function runAgent(dir: string, options: RunOptions): Promise<RunResult> {
  const plan = await computePlan(dir, {
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    interactive: options.interactive,
  });
  const { config } = plan.context;
  const agentConfig = config.agents[plan.agentId];

  // Resolve the adapter and fail early with an install hint if missing.
  const adapter = buildAdapter(plan.agentId, agentConfig);
  const installed = await adapter.detect();
  if (!installed) {
    throw new YuhiError("AGENT_NOT_INSTALLED", adapter.installHint(), {
      hint: `Install ${adapter.displayName}, or try \`yuhi run dummy\` to see the flow offline.`,
    });
  }

  // Generate the filtered workspace (dry-run supported).
  const { manifest, treeDir, warnings } = createWorkspace({
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

  const preview = buildPreview(plan);
  preview.warnings.push(...warnings);
  await options.hooks?.onBeforeLaunch?.(preview, manifest);

  if (options.dryRun) {
    return { manifest, exitCode: null, workspaceKept: false, preview };
  }

  // Record the context snapshot so `yuhi status` / `yuhi diff` can report changes.
  saveSnapshot(snapshotFromPlan(plan));

  // Build the child environment: allow-listed vars only (T7).
  const passthrough = [
    ...defaultEnvPassthrough(plan.agentId),
    ...(agentConfig?.env_passthrough ?? []),
  ];
  const missing = missingPassthrough(passthrough);
  if (missing.length > 0) options.hooks?.onMissingEnv?.(plan.agentId, missing);
  const env = buildChildEnv(passthrough);

  // "Runtime only" route: inject .env-style values into the process (never the
  // context the agent reads). Values are never logged — only names, on request.
  const injected = collectInjectedEnv(plan);
  Object.assign(env, injected.vars);
  if (injected.keys.length > 0) options.hooks?.onInjected?.(injected.keys, injected.sources);

  const ctx = {
    agentId: plan.agentId,
    workspacePath: treeDir,
    forwardedArgs: options.forwardedArgs,
    env,
    interactive: options.interactive,
  };

  const validation = await adapter.validate(ctx);
  if (!validation.ok) {
    throw new YuhiError("AGENT_NOT_FOUND", `Cannot run ${adapter.displayName}:`, {
      hint: validation.problems.join("; "),
    });
  }

  const command = await adapter.buildCommand(ctx);
  const start = Date.now();
  const result = await runCommand(command);
  const durationMs = Date.now() - start;

  // Audit (metadata only).
  if (config.audit.enabled) {
    writeAudit(
      buildAuditRecord(plan, {
        outcome: "ran",
        exitCode: result.exitCode,
        durationMs,
        manifest,
      }),
    );
    pruneAudit(config.audit.retention_days);
  }

  // Cleanup policy.
  const mode = options.cleanup ?? config.workspace.cleanup;
  let workspaceKept = true;
  if (mode === "always") {
    cleanWorkspace(manifest.id);
    workspaceKept = false;
  } else if (mode === "prompt" && options.interactive && options.hooks?.confirmCleanup) {
    const remove = await options.hooks.confirmCleanup(manifest);
    if (remove) {
      cleanWorkspace(manifest.id);
      workspaceKept = false;
    }
  }

  return { manifest, exitCode: result.exitCode, workspaceKept, preview };
}

export type { Plan };
