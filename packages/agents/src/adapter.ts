/**
 * Agent Adapter contract (Yuhi v0.3.4) — "one prepared repository, multiple agents".
 *
 * An AgentAdapter is the ONLY seam through which a specific agent (Claude Code,
 * Codex, …) plugs into Yuhi. Fixing this contract first lets later adapters plug
 * in without divergent structures.
 *
 * The adapter OWNS (agent-specific concerns):
 *   - detection (with a SHORT timeout)
 *   - agent-specific instruction file generation
 *   - launch command assembly: executable + args ARRAY (never a shell string)
 *   - working directory = the prepared repository
 *   - session metadata
 *   - agent-specific warnings
 *
 * The adapter MUST NOT own (Yuhi core concerns):
 *   - safety scanning, compression, token budgeting, repository map
 *   - Context ID generation
 *   - source mutation
 *   - applying agent changes back to the source
 *
 * `AgentAdapter`, `AgentAvailability`, `AgentSession`/`AgentLaunchResult` are
 * STABLE public types. Change them only with deliberate versioning.
 */
import type { AgentCommand } from "@yuhi/shared";

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

export interface AgentDetectOptions {
  /**
   * SHORT detection budget in milliseconds (2000–3000 recommended). Detection
   * must never block a launch surface: if it cannot answer within the budget it
   * resolves `available: false` rather than hanging.
   */
  timeoutMs?: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

export const DEFAULT_DETECT_TIMEOUT_MS = 2500;

export interface AgentAvailability {
  readonly id: string;
  readonly available: boolean;
  /**
   * Resolved absolute executable path when available. RUN-LOCAL only — never
   * copied into a public Context/Session manifest export.
   */
  readonly executablePath?: string;
  /** Version string when cheaply known (no process spawn required to detect). */
  readonly version?: string;
  /** Shown to the user when `available` is false. Content-free, path-free. */
  readonly installHint?: string;
}

// ---------------------------------------------------------------------------
// prepare()
// ---------------------------------------------------------------------------

/**
 * The shared, agent-independent prepared context. Produced by Yuhi core (the
 * prepare pipeline), consumed unchanged by EVERY adapter — this is what makes a
 * single prepared repository usable by multiple agents.
 */
export interface PreparedAgentContext {
  /** Absolute path to the prepared repository — the agent's working directory. */
  readonly workingDirectory: string;
  /** Deterministic, agent-independent Context ID (`sha256:<hex>`). */
  readonly contextId: string;
  /** Prepared run id (bookkeeping; NOT part of the Context ID). */
  readonly runId: string;
}

export interface AgentPrepareOptions {
  /** Extra args to forward to the agent CLI (everything after `--`). */
  readonly forwardedArgs?: readonly string[];
  /** Env var NAMES explicitly allow-listed to reach the child (values resolved at launch). */
  readonly envPassthrough?: readonly string[];
}

/** An agent-specific instruction file to be written into the prepared repo. */
export interface AgentInstructionFile {
  /** Repo-relative POSIX path inside the prepared repository. */
  readonly relpath: string;
  readonly contents: string;
}

/**
 * The fully-assembled, ready-to-launch plan for one adapter. Command is an
 * executable + args ARRAY — NEVER a shell string (THREAT_MODEL T6).
 */
export interface PreparedAgentLaunch {
  readonly adapterId: string;
  readonly contextId: string;
  /** Working directory = the prepared repository. */
  readonly workingDirectory: string;
  /** Resolved executable to spawn. */
  readonly executable: string;
  /** argv array — never a concatenated shell string. */
  readonly args: readonly string[];
  /** Agent-specific instruction files to materialize in the prepared repo. */
  readonly instructionFiles: readonly AgentInstructionFile[];
  /** Env var NAMES to pass through at launch (values resolved by the runner). */
  readonly envPassthrough: readonly string[];
  /** Agent-specific, content-free warnings surfaced before/at launch. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// launch()
// ---------------------------------------------------------------------------

export interface AgentLaunchOptions {
  /**
   * When false, assemble + validate but DO NOT spawn (dry run). Defaults to true.
   */
  readonly spawn?: boolean;
  /**
   * Injected child-process runner (for tests / alternative hosts). Defaults to
   * the real argv-array spawn. Receives an {@link AgentCommand} (never a shell string).
   */
  readonly runner?: (command: AgentCommand) => Promise<AgentRunOutcome>;
  /** Deterministic session id (tests). Otherwise the adapter generates one. */
  readonly sessionId?: string;
  /** Deterministic ISO start timestamp (tests). */
  readonly startedAt?: string;
  /** Resolve an allow-listed env var value. Defaults to reading process.env. */
  readonly resolveEnv?: (name: string) => string | undefined;
}

export interface AgentRunOutcome {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

export type AgentSessionStatus = "prepared" | "launched" | "exited" | "failed";

/**
 * The per-run Agent Session — the STABLE result of a launch. Carries the link
 * back to the deterministic Context ID plus run-specific info. Its PUBLIC export
 * (see @yuhi/agents session-manifest) must NOT contain absolute paths, env
 * values, raw secret args, or user/machine identity.
 */
export interface AgentSession {
  readonly sessionId: string;
  readonly contextId: string;
  readonly agent: { id: string; displayName: string; adapterVersion: string };
  /** Absolute working directory (RUN-LOCAL; excluded from public exports). */
  readonly workingDirectory: string;
  readonly status: AgentSessionStatus;
  readonly startedAt: string;
  readonly exitCode?: number;
}

/** Alias kept for callers that speak in terms of a launch result. */
export type AgentLaunchResult = AgentSession;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Adapter implementation version — recorded in the Agent Session Manifest. */
  readonly adapterVersion: string;

  /** Is the underlying agent installed & runnable? Uses a SHORT timeout. */
  detect(options?: AgentDetectOptions): Promise<AgentAvailability>;

  /**
   * Assemble the launch plan for the shared prepared context. Pure w.r.t. Yuhi
   * core: it never scans, compresses, budgets, mutates source, or generates the
   * Context ID — it only shapes agent-specific command/instructions/warnings.
   */
  prepare(
    context: PreparedAgentContext,
    options?: AgentPrepareOptions,
  ): Promise<PreparedAgentLaunch>;

  /** Launch the assembled plan and return the per-run Agent Session. */
  launch(
    plan: PreparedAgentLaunch,
    options?: AgentLaunchOptions,
  ): Promise<AgentSession>;
}
