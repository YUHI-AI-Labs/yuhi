/**
 * Test helpers for the v0.3.4 agent adapter contract.
 *
 * `createFakeAgentAdapter` is a fully in-memory {@link AgentAdapter} with no CLI,
 * no PATH lookup, and no spawn. It lets contract tests exercise detect/prepare/
 * launch and prove that a single prepared context is usable by multiple adapters.
 */
import type {
  AgentAdapter,
  AgentAvailability,
  AgentDetectOptions,
  AgentLaunchOptions,
  AgentPrepareOptions,
  AgentSession,
  PreparedAgentContext,
  PreparedAgentLaunch,
} from "./adapter.js";

export interface FakeAgentAdapterOptions {
  id?: string;
  displayName?: string;
  adapterVersion?: string;
  /** What detect() reports. Defaults to available. */
  available?: boolean;
  /** Fixed args placed before forwarded args. */
  configArgs?: readonly string[];
  /** Instruction files the fake writes into the prepared repo. */
  instructionFiles?: PreparedAgentLaunch["instructionFiles"];
}

/** Build a deterministic, dependency-free adapter for contract tests. */
export function createFakeAgentAdapter(options: FakeAgentAdapterOptions = {}): AgentAdapter {
  const id = options.id ?? "fake";
  const displayName = options.displayName ?? "Fake Agent";
  const adapterVersion = options.adapterVersion ?? "0.0.0-test";
  const available = options.available ?? true;

  return {
    id,
    displayName,
    adapterVersion,
    async detect(_options?: AgentDetectOptions): Promise<AgentAvailability> {
      return available
        ? { id, available: true, executablePath: `/fake/bin/${id}` }
        : { id, available: false, installHint: `Install ${displayName}.` };
    },
    async prepare(
      context: PreparedAgentContext,
      prepareOptions?: AgentPrepareOptions,
    ): Promise<PreparedAgentLaunch> {
      return {
        adapterId: id,
        contextId: context.contextId,
        workingDirectory: context.workingDirectory,
        executable: `/fake/bin/${id}`,
        args: [...(options.configArgs ?? []), ...(prepareOptions?.forwardedArgs ?? [])],
        instructionFiles: options.instructionFiles ?? [],
        envPassthrough: [...(prepareOptions?.envPassthrough ?? [])],
        warnings: [],
      };
    },
    async launch(
      plan: PreparedAgentLaunch,
      launchOptions?: AgentLaunchOptions,
    ): Promise<AgentSession> {
      const sessionId = launchOptions?.sessionId ?? `${id}-session`;
      const startedAt = launchOptions?.startedAt ?? "1970-01-01T00:00:00.000Z";
      const base = {
        sessionId,
        contextId: plan.contextId,
        agent: { id, displayName, adapterVersion },
        workingDirectory: plan.workingDirectory,
        startedAt,
      };
      if (launchOptions?.spawn === false) return { ...base, status: "prepared" };
      const outcome = await (launchOptions?.runner
        ? launchOptions.runner({
            file: plan.executable,
            args: [...plan.args],
            cwd: plan.workingDirectory,
            env: {},
          })
        : Promise.resolve({ exitCode: 0, signal: null }));
      return {
        ...base,
        status: outcome.exitCode === 0 ? "exited" : "failed",
        exitCode: outcome.exitCode,
      };
    },
  };
}
