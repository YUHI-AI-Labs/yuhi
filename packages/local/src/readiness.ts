import { LocalModelError, type LocalModelProvider } from "@yuhi/shared";

/**
 * Local-AI readiness. Crucially, "ready" requires a successful INFERENCE smoke test —
 * a reachable API + installed model is NOT enough (a broken model runner can 500 on
 * every generation while /api/tags still succeeds). Doctor / status bar / onboarding
 * all consume this so they never report Ready on an API-only check.
 */
export type LocalAiState = "stopped" | "model-missing" | "inference-failed" | "ready";

export interface LocalModelReadiness {
  apiReachable: boolean;
  models: string[];
  configuredModel: string;
  modelInstalled: boolean;
  inference: { ok: boolean; reason?: string };
  state: LocalAiState;
}

/** A tiny, formatting-tolerant smoke prompt. */
export const SMOKE_PROMPT = "Reply with exactly: OK";

/** Actionable next steps when inference fails (shown to the user; never auto-applied). */
export const INFERENCE_FAILURE_ACTIONS = [
  "restart Ollama",
  "update Ollama",
  "unload and reload the model",
  "test the configured model directly",
  "choose another installed model",
] as const;

function installed(models: string[], model: string): boolean {
  return models.some(
    (m) => m === model || m === `${model}:latest` || (model.includes(":") ? false : m.startsWith(`${model}:`)),
  );
}

/**
 * Evaluate readiness: API reachable → model installed → inference smoke test.
 * Never throws. The inference smoke uses a short, bounded timeout and only requires
 * NON-EMPTY output (models may add formatting/thinking around "OK").
 */
export async function localModelReadiness(
  provider: LocalModelProvider,
  opts: { model?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LocalModelReadiness> {
  const configuredModel = opts.model ?? provider.defaultModel;
  const health = await provider.health();
  if (!health.ok) {
    return {
      apiReachable: false,
      models: [],
      configuredModel,
      modelInstalled: false,
      inference: { ok: false },
      state: "stopped",
    };
  }
  const models = health.models ?? [];
  if (!installed(models, configuredModel)) {
    return {
      apiReachable: true,
      models,
      configuredModel,
      modelInstalled: false,
      inference: { ok: false },
      state: "model-missing",
    };
  }
  // Inference smoke test — the check that would have caught the Metal/XPC 500s.
  const genOpts: { model: string; timeoutMs: number; signal?: AbortSignal } = {
    model: configuredModel,
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
  if (opts.signal) genOpts.signal = opts.signal;
  try {
    const out = await provider.generate(SMOKE_PROMPT, genOpts);
    if (typeof out === "string" && out.trim().length > 0) {
      return { apiReachable: true, models, configuredModel, modelInstalled: true, inference: { ok: true }, state: "ready" };
    }
    return {
      apiReachable: true,
      models,
      configuredModel,
      modelInstalled: true,
      inference: { ok: false, reason: "inference returned empty output" },
      state: "inference-failed",
    };
  } catch (e) {
    const err = e as LocalModelError;
    const reason = err.code ? `${err.code} — ${err.message}` : err.message || "inference failed";
    return {
      apiReachable: true,
      models,
      configuredModel,
      modelInstalled: true,
      inference: { ok: false, reason },
      state: "inference-failed",
    };
  }
}
