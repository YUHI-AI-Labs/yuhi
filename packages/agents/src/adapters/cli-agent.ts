/**
 * Foundation CLI adapter (Yuhi v0.3.4).
 *
 * A vendor-neutral {@link AgentAdapter} for any agent launched as a CLI whose
 * working directory IS the prepared repository and whose forwarded args are
 * appended. This is the FOUNDATION the later Claude/Codex-specific adapters build
 * on — it is NOT the Claude/Codex real launch implementation.
 *
 * It reuses Yuhi's existing, audited primitives:
 *   - `lookupOnPath` for detection + executable resolution (no spawn to detect)
 *   - `buildChildEnv` for the minimal, allow-listed child environment (T7)
 *   - `runCommand` for the argv-array spawn (never a shell string, T6)
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
} from "../adapter.js";
import { DEFAULT_DETECT_TIMEOUT_MS } from "../adapter.js";
import type { CliAgentSpec } from "../registry.js";
import { lookupOnPath } from "../which.js";
import { buildChildEnv } from "../env.js";
import { runCommand } from "../run.js";
import { randomUUID } from "node:crypto";

/** Adapter implementation version — recorded in the Agent Session Manifest. */
export const CLI_AGENT_ADAPTER_VERSION = "0.3.4";

class CliAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion = CLI_AGENT_ADAPTER_VERSION;

  constructor(private readonly spec: CliAgentSpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
  }

  private installHint(): string {
    const base = `The "${this.spec.command}" CLI was not found on your PATH.`;
    return this.spec.installHintUrl ? `${base} Install it from ${this.spec.installHintUrl}.` : base;
  }

  async detect(options?: AgentDetectOptions): Promise<AgentAvailability> {
    // A SHORT budget so a launch surface never hangs on detection. `lookupOnPath`
    // is a synchronous PATH walk (no spawn), so we simply race it against the budget.
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    const resolve = new Promise<string | null>((done) => done(lookupOnPath(this.spec.command)));
    const budget = new Promise<null>((done) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      options?.signal?.addEventListener("abort", () => done(null), { once: true });
    });
    const executablePath = await Promise.race([resolve, budget]);
    return executablePath
      ? { id: this.id, available: true, executablePath }
      : { id: this.id, available: false, installHint: this.installHint() };
  }

  async prepare(
    context: PreparedAgentContext,
    options?: AgentPrepareOptions,
  ): Promise<PreparedAgentLaunch> {
    const executable = lookupOnPath(this.spec.command);
    const warnings: string[] = [];
    if (!executable) warnings.push(this.installHint());
    // Working directory = the prepared repository. Args are an ARRAY, assembled as
    // [configArgs, forwardedArgs] — never concatenated into a shell string.
    const args = [...(this.spec.configArgs ?? []), ...(options?.forwardedArgs ?? [])];
    const envPassthrough = [
      ...(this.spec.envPassthrough ?? []),
      ...(options?.envPassthrough ?? []),
    ];
    return {
      adapterId: this.id,
      contextId: context.contextId,
      workingDirectory: context.workingDirectory,
      executable: executable ?? this.spec.command,
      args,
      // Agent-specific instruction files are the adapter's job; the foundation
      // adapter ships none (the prepared repo already carries Yuhi's handoff).
      instructionFiles: [],
      envPassthrough,
      warnings,
    };
  }

  async launch(plan: PreparedAgentLaunch, options?: AgentLaunchOptions): Promise<AgentSession> {
    const sessionId = options?.sessionId ?? randomUUID();
    const startedAt = options?.startedAt ?? new Date().toISOString();
    const agent = { id: this.id, displayName: this.displayName, adapterVersion: this.adapterVersion };
    const base = {
      sessionId,
      contextId: plan.contextId,
      agent,
      workingDirectory: plan.workingDirectory,
      startedAt,
    };

    if (options?.spawn === false) {
      return { ...base, status: "prepared" };
    }

    const env = buildChildEnv(plan.envPassthrough as string[]);
    const command = {
      file: plan.executable,
      args: [...plan.args],
      cwd: plan.workingDirectory,
      env,
    };
    const run = options?.runner ?? runCommand;
    try {
      const outcome = await run(command);
      return {
        ...base,
        status: outcome.exitCode === 0 ? "exited" : "failed",
        exitCode: outcome.exitCode,
      };
    } catch {
      return { ...base, status: "failed" };
    }
  }
}

/** Construct the foundation CLI adapter for a vendor-neutral spec. */
export function createCliAgentAdapter(spec: CliAgentSpec): AgentAdapter {
  return new CliAgentAdapter(spec);
}
