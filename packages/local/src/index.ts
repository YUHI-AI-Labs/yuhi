export * from "./ollama.js";
export * from "./readiness.js";

import { DEFAULT_LOCAL_MODEL, type LocalModelConfig, type LocalModelProvider } from "@yuhi/shared";
import { createOllamaProvider } from "./ollama.js";

/**
 * Build a LocalModelProvider from a LocalModelConfig. Today only "ollama" is
 * supported; the switch is the single place a future provider plugs in.
 */
export function createLocalModelProvider(
  config: Partial<LocalModelConfig> = {},
): LocalModelProvider {
  const cfg = { ...DEFAULT_LOCAL_MODEL, ...config };
  switch (cfg.provider) {
    case "ollama":
      return createOllamaProvider({
        endpoint: cfg.endpoint,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
    default:
      // Unknown provider → fall back to Ollama defaults rather than throwing at
      // construction; health() will report unreachable if it truly isn't there.
      return createOllamaProvider({
        endpoint: cfg.endpoint,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
  }
}
