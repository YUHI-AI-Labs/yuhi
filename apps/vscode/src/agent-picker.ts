/**
 * v0.3.4 — "One prepared repository, multiple agents": the Agent Picker.
 *
 * Theme: **Prepared once. Reusable across agents.** After a successful prepare, the
 * user chooses which agent (Claude Code, Codex, …) to launch into the SAME prepared
 * repository — the same {@link PreparedAgentContext} (same Context ID, no re-prepare,
 * no re-scan, no re-compress). Every launch is routed through the allowlisted
 * {@link https | @yuhi/agents} registry adapters (`registry.get(id)` →
 * `detect()/prepare()/launch()`), so an unknown agent id can never be launched.
 *
 * This module is split into:
 *   - a PURE renderer ({@link renderAgentPicker}) — no VS Code, no DOM, unit-tested;
 *   - HOST-WIRING orchestration (detect / launch / last-used) that takes an injected
 *     registry + runner so it is fully testable with FAKE adapters and a fake runner.
 *
 * Reliability (v0.3.3 principle — never hang / never stuck):
 *   - detection ALWAYS times out (2–3s) and resolves "unavailable" rather than hanging;
 *   - a failed OR cancelled launch returns the UI to a usable state — the "Launching…"
 *     flag is ALWAYS cleared in a `finally`, so the picker is never stuck;
 *   - a launch failure for one agent never prevents trying the other.
 *
 * Privacy: nothing user-visible here carries an absolute path, env value, or secret.
 * The Context ID is a content hash (`sha256:…`); commands are structured argv arrays
 * assembled by the adapter (never built from repo file contents).
 */
import type { AgentCommand } from "@yuhi/shared";
import type {
  AgentAdapter,
  AgentAvailability,
  AgentRunOutcome,
  AgentSession,
  PreparedAgentContext,
} from "@yuhi/agents";
import { DEFAULT_DETECT_TIMEOUT_MS } from "@yuhi/agents";

/** The allowlisted agent ids the picker offers, in display order. Mirrors the
 *  registry's `ALLOWLISTED_AGENT_IDS`; kept local so the picker never launches an id
 *  the registry would reject. */
export const PICKER_AGENT_IDS = ["claude", "codex"] as const;
export type PickerAgentId = (typeof PICKER_AGENT_IDS)[number];

/** Human display names (the registry owns the canonical ones; these are the picker
 *  labels used before an adapter is resolved / when detection failed). */
export const PICKER_AGENT_DISPLAY_NAMES: Record<PickerAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Calm, content-free install hints shown when an agent is not installed. NEVER a
 *  path; NEVER an instruction to auto-install (Yuhi never runs an install). */
export const PICKER_AGENT_INSTALL_HINTS: Record<PickerAgentId, string> = {
  claude: "Claude Code CLI was not found. Install Claude Code and try again.",
  codex: "Codex CLI was not found. Install Codex and try again.",
};

/** Short detection budget — a launch surface must never hang on detection. */
export const PICKER_DETECT_TIMEOUT_MS = DEFAULT_DETECT_TIMEOUT_MS;

/** Persisted key for the last-used agent (workspaceState / globalState Memento). */
export const LAST_AGENT_STATE_KEY = "yuhi.lastAgentId";

/** Tagline shown under the picker. */
export const PICKER_TAGLINE = "Prepared once. Reusable across agents.";

function isPickerAgentId(value: unknown): value is PickerAgentId {
  return typeof value === "string" && (PICKER_AGENT_IDS as readonly string[]).includes(value);
}

function defaultInstallHint(id: string): string {
  return isPickerAgentId(id)
    ? PICKER_AGENT_INSTALL_HINTS[id]
    : `The ${id} CLI was not found. Install it and try again.`;
}

function displayNameFor(id: string): string {
  return isPickerAgentId(id) ? PICKER_AGENT_DISPLAY_NAMES[id] : id;
}

// ---------------------------------------------------------------------------
// Pure render.
// ---------------------------------------------------------------------------

/** One agent's button state in the picker. */
export interface AgentButtonState {
  id: string;
  displayName: string;
  /** From `adapter.detect()` — false disables/softens the button. */
  available: boolean;
  /** Shown inline when `available` is false (calm, path-free). */
  installHint?: string;
  /** The last-used agent → rendered as the primary/default action. */
  isDefault?: boolean;
  /** This agent is mid-launch ("Launching…"). Cleared on settle (never stuck). */
  launching?: boolean;
}

export interface AgentPickerData {
  /** The prepared run's deterministic Context ID (`sha256:…`). */
  contextId: string;
  agents: AgentButtonState[];
  /**
   * The selected Safety Mode differs from the prepared run → launching is BLOCKED
   * for BOTH agents until re-prepare (existing "Re-prepare required" gate).
   */
  dirty?: boolean;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Abbreviate a Context ID for display while keeping it recognizably a hash. The full
 *  id is placed in a `title` so it can be inspected but does not dominate the panel. */
export function shortContextId(contextId: string): string {
  const match = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(contextId);
  if (!match) return contextId;
  const [, algo, hex] = match;
  return `${algo}:${hex!.slice(0, 10)}…`;
}

/**
 * The picker markup — MARKUP ONLY (no `<script>`): it is embedded into a webview that
 * already owns the single `acquireVsCodeApi()` handle and wires the button ids/classes.
 * Each enabled agent button carries `class="agentBtn"` + `data-agent="<id>"`; the host
 * script posts `{ type: "launchAgent", agentId }`.
 */
export function renderAgentPicker(data: AgentPickerData): string {
  const dirty = data.dirty === true;
  const buttons = data.agents
    .map((agent) => {
      const label = agent.launching ? "Launching…" : esc(agent.displayName);
      const disabled = !agent.available || dirty || agent.launching;
      const cls = ["agentBtn", agent.isDefault && agent.available && !dirty ? "primary" : ""]
        .filter(Boolean)
        .join(" ");
      const attrs =
        `type="button" class="${cls}" data-agent="${esc(agent.id)}"` +
        (disabled ? ' disabled aria-disabled="true"' : "") +
        (agent.isDefault && !dirty ? ' data-default="true"' : "");
      const hint =
        !agent.available && !agent.launching
          ? `<div class="agentHint">${esc(agent.installHint ?? defaultInstallHint(agent.id))}</div>`
          : "";
      return `<div class="agentChoice"><button ${attrs}>${label}</button>${hint}</div>`;
    })
    .join("");
  const dirtyBanner = dirty
    ? `<div class="agentDirty"><b>Re-prepare required</b><span>The selected Safety Mode differs ` +
      `from the prepared run. Re-prepare to launch either agent.</span></div>`
    : "";
  return (
    `<div class="agentPicker" role="group" aria-label="Launch with an agent">` +
    `<div class="agentPickerHead">Launch with</div>` +
    `<div class="agentBtns">${buttons}</div>` +
    dirtyBanner +
    `<div class="agentCtx"><span class="agentCtxLabel">Context ID</span>` +
    `<code class="agentCtxId" title="${esc(data.contextId)}">${esc(shortContextId(data.contextId))}</code></div>` +
    `<div class="agentTagline">${esc(PICKER_TAGLINE)}</div>` +
    `</div>`
  );
}

/**
 * Build {@link AgentPickerData} from resolved availabilities + persisted last-used.
 * The default (primary) agent is the last-used one when it is available; otherwise the
 * first available agent; otherwise none. Launching state is per-id.
 */
export function buildAgentPickerData(params: {
  contextId: string;
  availabilities: readonly AgentAvailability[];
  lastAgentId?: string;
  dirty?: boolean;
  launchingAgentId?: string | null;
}): AgentPickerData {
  const availableIds = params.availabilities.filter((a) => a.available).map((a) => a.id);
  const defaultId =
    params.lastAgentId && availableIds.includes(params.lastAgentId)
      ? params.lastAgentId
      : availableIds[0];
  const agents: AgentButtonState[] = params.availabilities.map((availability) => ({
    id: availability.id,
    displayName: displayNameFor(availability.id),
    available: availability.available,
    ...(availability.available ? {} : { installHint: availability.installHint ?? defaultInstallHint(availability.id) }),
    ...(availability.id === defaultId ? { isDefault: true } : {}),
    ...(params.launchingAgentId === availability.id ? { launching: true } : {}),
  }));
  return {
    contextId: params.contextId,
    agents,
    ...(params.dirty ? { dirty: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Host-wiring — detection (never hangs).
// ---------------------------------------------------------------------------

/** The minimal registry surface the picker consumes — decoupled from the concrete
 *  `AgentRegistry` class so tests can inject a fake `{ get }`. */
export interface AgentRegistryLike {
  get(id: string): Promise<AgentAdapter>;
}

export interface DetectAgentOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Detect a single agent's availability. GUARANTEES it never hangs: the adapter's own
 * `detect()` is raced against an independent timeout (belt-and-suspenders — even a
 * misbehaving adapter that ignores its budget cannot stall the UI). An unknown id or a
 * thrown detect resolves `available: false`.
 */
export async function detectAgentAvailability(
  registry: AgentRegistryLike,
  id: string,
  options: DetectAgentOptions = {},
): Promise<AgentAvailability> {
  const timeoutMs = options.timeoutMs ?? PICKER_DETECT_TIMEOUT_MS;
  const unavailable = (): AgentAvailability => ({
    id,
    available: false,
    installHint: defaultInstallHint(id),
  });
  try {
    const adapter = await registry.get(id);
    const detection = adapter.detect({
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const timeout = new Promise<AgentAvailability>((resolve) => {
      if (options.signal?.aborted) return resolve(unavailable());
      const timer = setTimeout(() => resolve(unavailable()), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      options.signal?.addEventListener("abort", () => resolve(unavailable()), { once: true });
    });
    return await Promise.race([detection, timeout]);
  } catch {
    return unavailable();
  }
}

/** Detect several agents concurrently. Order matches `ids`. Never hangs. */
export async function detectAgents(
  registry: AgentRegistryLike,
  ids: readonly string[],
  options: DetectAgentOptions = {},
): Promise<AgentAvailability[]> {
  return Promise.all(ids.map((id) => detectAgentAvailability(registry, id, options)));
}

// ---------------------------------------------------------------------------
// Host-wiring — a shared prepared context reused by every agent.
// ---------------------------------------------------------------------------

/** Minimal shape of a prepared run (a `PrepareReport`) the picker needs. */
export interface PreparedRunLike {
  contextId: string;
  outDir: string;
  runId: string;
}

/**
 * Build the ONE shared {@link PreparedAgentContext} from a prepared run. Every agent
 * launch reuses this exact object — same `contextId`, same `workingDirectory` — so
 * switching agents never re-prepares, re-scans, or re-compresses.
 */
export function preparedContextFromRun(run: PreparedRunLike): PreparedAgentContext {
  return {
    workingDirectory: run.outDir,
    contextId: run.contextId,
    runId: run.runId,
  };
}

export interface LaunchPreparedAgentOptions {
  /** Injected child runner — for VS Code this drives a terminal; tests pass a fake. */
  runner: (command: AgentCommand) => Promise<AgentRunOutcome>;
  forwardedArgs?: readonly string[];
  envPassthrough?: readonly string[];
  /** Deterministic ids for tests. */
  sessionId?: string;
  startedAt?: string;
}

/**
 * Launch one agent against the shared prepared context, THROUGH the registry adapter:
 * `registry.get(id)` (rejects a non-allowlisted id) → `adapter.prepare(context)` (plan
 * assembly, NOT Yuhi-core prepare) → `adapter.launch(plan, { runner })`. Reuses the
 * passed `context` verbatim, so no re-prepare happens when switching agents.
 */
export async function launchPreparedAgent(
  registry: AgentRegistryLike,
  id: string,
  context: PreparedAgentContext,
  options: LaunchPreparedAgentOptions,
): Promise<AgentSession> {
  const adapter = await registry.get(id);
  const plan = await adapter.prepare(context, {
    ...(options.forwardedArgs ? { forwardedArgs: [...options.forwardedArgs] } : {}),
    ...(options.envPassthrough ? { envPassthrough: [...options.envPassthrough] } : {}),
  });
  return adapter.launch(plan, {
    runner: options.runner,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
}

// ---------------------------------------------------------------------------
// Host-wiring — last-used persistence.
// ---------------------------------------------------------------------------

/** The subset of a VS Code Memento the picker uses (workspaceState / globalState). */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** The last-used agent id, if it is still an allowlisted picker agent. */
export function readLastAgentId(memento: MementoLike): PickerAgentId | undefined {
  const value = memento.get<string>(LAST_AGENT_STATE_KEY);
  return isPickerAgentId(value) ? value : undefined;
}

/** Remember the last-used agent (allowlisted ids only). */
export async function rememberLastAgentId(memento: MementoLike, id: string): Promise<void> {
  if (isPickerAgentId(id)) await memento.update(LAST_AGENT_STATE_KEY, id);
}

// ---------------------------------------------------------------------------
// Host-wiring — the orchestrated launch (dirty gate + reliability + last-used).
// ---------------------------------------------------------------------------

export type AgentLaunchResult =
  | { status: "blocked-dirty" }
  | { status: "unavailable"; id: string; installHint: string }
  | { status: "launched"; id: string; session: AgentSession }
  | { status: "failed"; id: string; error: string };

export interface RunAgentLaunchParams extends LaunchPreparedAgentOptions {
  registry: AgentRegistryLike;
  id: string;
  context: PreparedAgentContext;
  /** DIRTY gate: when true, launching is blocked for the agent (Re-prepare required). */
  dirty?: boolean;
  /** Known availability; when unavailable the launch is refused (calm message). */
  availability?: AgentAvailability;
  /** UI hook: `id` while launching, `null` on settle. ALWAYS cleared (never stuck). */
  onLaunchingChange?: (id: string | null) => void;
  /** Persist the last-used agent on success. */
  rememberLast?: (id: string) => Promise<void> | void;
}

/**
 * Orchestrate a single agent launch with the v0.3.4 guarantees:
 *   - DIRTY gate first — a dirty run is blocked WITHOUT ever entering "Launching…";
 *   - an unavailable agent is refused with a calm, path-free message;
 *   - the "Launching…" flag is set before and ALWAYS cleared in `finally`, so a
 *     failed OR cancelled launch returns the UI to a usable state (never stuck);
 *   - a failure is contained and returned as data — it never throws, so a failure for
 *     one agent cannot prevent trying the other;
 *   - on success the agent is remembered as last-used.
 */
export async function runAgentLaunch(params: RunAgentLaunchParams): Promise<AgentLaunchResult> {
  if (params.dirty) return { status: "blocked-dirty" };
  if (params.availability && !params.availability.available) {
    return {
      status: "unavailable",
      id: params.id,
      installHint: params.availability.installHint ?? defaultInstallHint(params.id),
    };
  }
  params.onLaunchingChange?.(params.id);
  try {
    const session = await launchPreparedAgent(params.registry, params.id, params.context, {
      runner: params.runner,
      ...(params.forwardedArgs ? { forwardedArgs: params.forwardedArgs } : {}),
      ...(params.envPassthrough ? { envPassthrough: params.envPassthrough } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.startedAt ? { startedAt: params.startedAt } : {}),
    });
    if (session.status === "failed") {
      return { status: "failed", id: params.id, error: "launch-failed" };
    }
    await params.rememberLast?.(params.id);
    return { status: "launched", id: params.id, session };
  } catch (error) {
    return {
      status: "failed",
      id: params.id,
      error: error instanceof Error ? error.name : "launch-error",
    };
  } finally {
    // ALWAYS clear the launching flag — a failed/cancelled launch is never left stuck.
    params.onLaunchingChange?.(null);
  }
}
