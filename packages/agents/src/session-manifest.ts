/**
 * Agent Session Manifest (Yuhi v0.3.4).
 *
 * The per-run counterpart to core's deterministic Context Manifest. One is
 * produced per adapter launch. It records WHICH agent ran against WHICH
 * deterministic context, plus run-specific status.
 *
 * The PUBLIC export MUST NOT contain: absolute paths, user/machine names, raw
 * command args (which may hold secrets), environment values, or personal info.
 * The internal {@link AgentSession} keeps `workingDirectory` (an absolute path)
 * for run-local use; {@link toPublicAgentSessionManifest} strips it.
 */
import type { AgentSession, AgentSessionStatus } from "./adapter.js";

/** The STABLE, public-safe Agent Session Manifest. */
export interface AgentSessionManifest {
  schemaVersion: 1;
  kind: "agent-session";
  sessionId: string;
  /** Links this run to the deterministic, agent-independent Context ID. */
  contextId: string;
  agent: { id: string; displayName: string; adapterVersion: string };
  status: AgentSessionStatus;
  startedAt: string;
  exitCode?: number;
}

/**
 * Project an {@link AgentSession} into its public-safe manifest. Deliberately
 * DROPS `workingDirectory` (absolute path) and copies only whitelisted, identity-
 * free fields — it never spreads the session, so no field can leak by accident.
 */
export function toPublicAgentSessionManifest(session: AgentSession): AgentSessionManifest {
  return {
    schemaVersion: 1,
    kind: "agent-session",
    sessionId: session.sessionId,
    contextId: session.contextId,
    agent: {
      id: session.agent.id,
      displayName: session.agent.displayName,
      adapterVersion: session.agent.adapterVersion,
    },
    status: session.status,
    startedAt: session.startedAt,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
  };
}
