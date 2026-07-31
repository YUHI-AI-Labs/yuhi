import { z } from "zod";
import { normalizeAction, DEFAULT_LOCAL_MODEL, type Action } from "@yuhi/shared";
import { DEFAULT_PREPARE_SAFETY_MODE, type SafetyMode } from "@yuhi/shared";

/** Accept friendly (send / remove-secrets / prepare-locally / runtime-only /
 *  keep-local / exclude) or internal action names, normalized to an Action. */
const actionEnum = z.string().transform((s, ctx) => {
  const a = normalizeAction(s);
  if (!a) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown action "${s}"` });
    return z.NEVER;
  }
  return a as Action;
});
const destinationEnum = z.enum(["external", "local"]);
const processorSpec = z.union([z.string(), z.object({ id: z.string() }).passthrough()]);

export const ruleMatchSchema = z
  .object({
    paths: z.array(z.string()).optional(),
    detectors: z.array(z.string()).optional(),
  })
  .refine((m) => (m.paths?.length ?? 0) + (m.detectors?.length ?? 0) > 0, {
    message: "A rule match must specify at least one of `paths` or `detectors`.",
  });

export const ruleSchema = z.object({
  name: z.string().min(1),
  match: ruleMatchSchema,
  action: actionEnum,
  reason: z.string().optional(),
  destinations: z.array(destinationEnum).optional(),
  /** For `prepare-locally`: the RouteExecutor pipeline (e.g. pseudonymize, safety-check). */
  processors: z.array(processorSpec).optional(),
});

export const agentSchema = z.object({
  command: z.string().min(1),
  destination: destinationEnum.default("external"),
  args: z.array(z.string()).optional(),
  /** Names of environment variables allowed to reach the child process. */
  env_passthrough: z.array(z.string()).optional(),
});

export const workspaceSchema = z.object({
  mode: z.enum(["copy"]).default("copy"),
  location: z.string().default("auto"),
  preserve_git: z.boolean().default(false),
  include_untracked: z.boolean().default(false),
  cleanup: z.enum(["prompt", "always", "never"]).default("prompt"),
  large_file_bytes: z.number().int().positive().default(5_000_000),
});

export const scanSchema = z.object({
  detectors: z.array(z.string()).optional(),
  keywords: z.array(z.string()).default([]),
  entropy_threshold: z.number().positive().default(4.0),
});

export const auditSchema = z.object({
  enabled: z.boolean().default(true),
  store_content: z.boolean().default(false),
  retention_days: z.number().int().positive().default(30),
});

export const privacySchema = z.object({
  telemetry: z.boolean().default(false),
});

/**
 * Optional local-model configuration for the "Prepare locally" route. When the
 * block is present its fields default to DEFAULT_LOCAL_MODEL; when the whole block
 * is absent the caller falls back to DEFAULT_LOCAL_MODEL. Local only — no cloud.
 */
export const localModelSchema = z.object({
  provider: z.string().default(DEFAULT_LOCAL_MODEL.provider),
  endpoint: z.string().default(DEFAULT_LOCAL_MODEL.endpoint),
  model: z.string().default(DEFAULT_LOCAL_MODEL.model),
  timeout_ms: z.number().int().positive().default(DEFAULT_LOCAL_MODEL.timeoutMs),
});

/**
 * Optional execution target. `local` (default) runs everything on this machine;
 * `managed` is reserved for a future hosted local-model runtime. Never a cloud LLM API.
 */
export const executionSchema = z.object({
  target: z.enum(["local", "managed"]).default("local"),
  provider: z.string().default("ollama"),
  model: z.string().optional(),
  region: z.string().optional(),
});

/**
 * Optional context budget: how aggressively preparation may reduce content and what
 * kinds of content to preserve. Mirrors @yuhi/shared ContextBudget.
 */
export const budgetSchema = z.object({
  max_input_tokens: z.number().int().positive().optional(),
  reduction_mode: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
  preserve: z.array(z.string()).default([]),
});

/**
 * v0.3.2 Safety Mode preset (see @yuhi/core `applySafetyMode`). Higher modes keep
 * more content local; absent → balanced. The string literals are kept in sync with
 * @yuhi/core `SafetyMode` by the compile-time guard below.
 */
export const safetyModeSchema = z.enum(["balanced", "strict", "maximum-privacy"]);

// Compile-time guard: fails to build if this enum ever diverges from core's SafetyMode.
type _SafetyModeEnumInSync = z.infer<typeof safetyModeSchema> extends SafetyMode
  ? SafetyMode extends z.infer<typeof safetyModeSchema>
    ? true
    : never
  : never;
const _safetyModeEnumInSync: _SafetyModeEnumInSync = true;
void _safetyModeEnumInSync;

export const yuhiConfigSchema = z.object({
  version: z.literal("1"),
  /** Safety Mode preset; omitted → balanced. */
  safetyMode: safetyModeSchema.default(DEFAULT_PREPARE_SAFETY_MODE),
  project: z.object({ name: z.string().optional() }).default({}),
  defaults: z
    .object({
      action: actionEnum.default("allow"),
      agent: z.string().default("claude"),
    })
    .default({ action: "allow", agent: "claude" }),
  workspace: workspaceSchema.default({}),
  rules: z.array(ruleSchema).default([]),
  agents: z.record(z.string(), agentSchema).default({}),
  scan: scanSchema.default({}),
  audit: auditSchema.default({}),
  privacy: privacySchema.default({}),
  /** Local-model settings; omitted → fall back to DEFAULT_LOCAL_MODEL. */
  local_model: localModelSchema.optional(),
  /** Execution target; omitted → local/ollama. */
  execution: executionSchema.optional(),
  /** Context budget; omitted → balanced reduction, preserve nothing extra. */
  budget: budgetSchema.optional(),
});

/** The fully-parsed, defaulted configuration object. */
export type YuhiConfig = z.infer<typeof yuhiConfigSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type LocalModelSettings = z.infer<typeof localModelSchema>;
export type ExecutionSettings = z.infer<typeof executionSchema>;
export type BudgetSettings = z.infer<typeof budgetSchema>;
