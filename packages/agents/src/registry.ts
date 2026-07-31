/**
 * Agent Registry (Yuhi v0.3.4).
 *
 * The registry is the single allowlist of agent adapters Yuhi will run. Its rules:
 *
 *   - IDs are ALLOWLISTED. `get(id)` for an id that was never registered is
 *     REJECTED (throws {@link UnknownAgentError}) and never executed.
 *   - Adapter factories are LAZY. Registering an adapter does not load its
 *     implementation or any agent-specific dependency; the factory runs only on
 *     the first `get(id)`. This keeps `import "@yuhi/agents"` cheap and free of
 *     every agent's transitive deps.
 *   - Resolved adapters are cached, so repeated `get(id)` returns the same instance.
 *
 * The registry itself owns NO agent-specific logic — that lives behind the factory.
 */
import type { AgentAdapter } from "./adapter.js";

export type AgentAdapterFactory = () => AgentAdapter | Promise<AgentAdapter>;

/** Thrown when a caller asks for an id that is not in the allowlist. */
export class UnknownAgentError extends Error {
  constructor(readonly id: string) {
    super(`Unknown agent adapter "${id}". It is not in the Yuhi allowlist.`);
    this.name = "UnknownAgentError";
  }
}

export class AgentRegistry {
  private readonly factories = new Map<string, AgentAdapterFactory>();
  private readonly resolved = new Map<string, AgentAdapter>();

  /** Register (or replace) an adapter id with a LAZY factory. */
  register(id: string, factory: AgentAdapterFactory): this {
    if (!id) throw new Error("An agent adapter id must be a non-empty string.");
    this.factories.set(id, factory);
    this.resolved.delete(id);
    return this;
  }

  /** Is this id allowlisted? (Does NOT load the adapter.) */
  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** The allowlisted ids, sorted for deterministic surfaces. */
  ids(): string[] {
    return [...this.factories.keys()].sort();
  }

  /**
   * Resolve the adapter for an allowlisted id, loading it lazily on first use.
   * Unknown ids are rejected — the registry never executes an unregistered id.
   */
  async get(id: string): Promise<AgentAdapter> {
    const cached = this.resolved.get(id);
    if (cached) return cached;
    const factory = this.factories.get(id);
    if (!factory) throw new UnknownAgentError(id);
    const adapter = await factory();
    this.resolved.set(id, adapter);
    return adapter;
  }
}

/**
 * The allowlisted agent ids Yuhi intends to support. The real Claude/Codex launch
 * adapters are wired here later (via lazy factories); this const is the stable
 * allowlist the UI and CLI enumerate against.
 */
export const ALLOWLISTED_AGENT_IDS = ["claude", "codex"] as const;
export type AllowlistedAgentId = (typeof ALLOWLISTED_AGENT_IDS)[number];

/** Vendor-neutral spec used by the foundation CLI adapter. */
export interface CliAgentSpec {
  id: string;
  displayName: string;
  command: string;
  installHintUrl?: string;
  envPassthrough?: readonly string[];
  /** Optional fixed args placed before forwarded args. */
  configArgs?: readonly string[];
}

/**
 * Per-agent specs for the allowlisted ids. Command/hints only — NO launch logic
 * here, and importing this module loads NO agent binary or heavy dependency.
 */
export const CLI_AGENT_SPECS: Record<AllowlistedAgentId, CliAgentSpec> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    command: "claude",
    installHintUrl: "https://docs.anthropic.com/en/docs/claude-code",
    envPassthrough: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    command: "codex",
    installHintUrl: "https://github.com/openai/codex",
    envPassthrough: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  },
};

/**
 * Build the default registry with the allowlisted adapters wired to LAZY factories.
 * The foundation `cli-agent` adapter module is imported only when an id is first
 * resolved — so `createDefaultRegistry()` (and importing @yuhi/agents) loads no
 * adapter implementation.
 */
export function createDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  for (const id of ALLOWLISTED_AGENT_IDS) {
    registry.register(id, async () => {
      const mod = await import("./adapters/cli-agent.js");
      return mod.createCliAgentAdapter(CLI_AGENT_SPECS[id]);
    });
  }
  return registry;
}
