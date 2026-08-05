/**
 * Native Claude GUI Mode — the shared vocabulary (v0.4.1).
 *
 * Native GUI Mode runs the OFFICIAL Anthropic Claude Code extension inside an isolated
 * VS Code environment whose `claudeCode.environmentVariables` point the `claude` child
 * process at a Yuhi Dynamic Gateway. It adds no gateway, no scanner, no compressor and no
 * secret policy: every one of those comes from the v0.4.0 runtime, so the CLI, Dynamic
 * Terminal Mode and Native GUI Mode cannot drift apart.
 *
 * The feasibility gate that authorised this design is recorded in
 * `docs/design/V0_4_1_NATIVE_GUI_FEASIBILITY.md` §5.
 */

import type { DeliveryMode } from "@yuhi/context-runtime";
import type { PrivacyMode } from "@yuhi/shared";

import type { RetrievalMode } from "../anthropic/transform.js";
import type { DynamicContextStats } from "../launch-session.js";

/**
 * The lifecycle, spelled out rather than collapsed into "starting". A user whose session
 * stalls needs to know whether VS Code never launched, the extension never installed, or
 * the window launched and never attached — those have different remedies.
 */
export type NativeSessionState =
  | "created"
  | "preparing"
  | "prepared"
  | "gateway-starting"
  | "gateway-ready"
  | "profile-provisioning"
  | "extension-installing"
  | "vscode-launching"
  | "vscode-started"
  | "vscode-attaching"
  | "vscode-attached"
  | "claude-activating"
  | "claude-ready"
  | "active"
  | "closing"
  | "closed"
  | "failed"
  | "orphaned"
  | "cleanup-failed";

/** States from which no further progress is possible without a new session. */
export const TERMINAL_STATES: readonly NativeSessionState[] = [
  "closed",
  "failed",
  "orphaned",
  "cleanup-failed",
];

export function isTerminal(state: NativeSessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type NativeSessionCloseReason =
  | "user-request"
  | "window-closed"
  | "attach-timeout"
  | "heartbeat-timeout"
  | "gateway-failure"
  | "extension-host-shutdown"
  | "recovery-sweep"
  | "startup-failure";

/** Which surface a gateway session belongs to. Recorded so metrics stay separable. */
export type ClientSurface = "cli" | "dynamic-terminal" | "native-gui";

export interface StartNativeClaudeGuiOptions {
  readonly sourceWorkspace: string;
  readonly preparedWorkspace?: string;
  /** LEGACY, superseded by `privacyMode` (v0.4.8) — ignored when `privacyMode` is given. */
  readonly deliveryMode: DeliveryMode;
  /** What happens to DIRECT PERSONAL IDENTIFIERS (v0.4.8). Takes precedence over the
   *  legacy `deliveryMode`. The caller resolves this via `resolveLaunchPrivacyMode`
   *  before calling in, so it arrives here already-valid. */
  readonly privacyMode?: PrivacyMode;
  readonly privacyModeAcknowledged?: boolean;
  readonly retrievalMode: RetrievalMode;
  /** Pin a specific official-extension version. Omitted means "whatever satisfies the contract". */
  readonly extensionVersion?: string;
  readonly vscodeExecutable?: string;
  /**
   * Which build of Yuhi to install into the isolated window: a marketplace id by default,
   * or a `.vsix` path when running a build that is not published yet.
   */
  readonly yuhiExtensionRef?: string;
  /**
   * Absolute path to the bundled Yuhi MCP stdio server. Required for retrieval to be
   * offered at all: the official extension owns the `claude` command line, so registration
   * has to go through a project-scoped `.mcp.json` pointing at a real script.
   */
  readonly mcpServerScript?: string;
  readonly signal?: AbortSignal;
}

export interface NativeSessionDiagnostics {
  readonly sessionId: string;
  readonly state: NativeSessionState;
  readonly gatewayHealthy: boolean;
  readonly vscodeAttached: boolean;
  readonly claudeExtensionVersion: string | undefined;
  readonly deliveryMode: DeliveryMode;
  readonly privacyMode?: PrivacyMode;
  readonly retrievalMode: RetrievalMode;
  readonly lastHeartbeatAt: string | undefined;
  readonly requests: number;
  readonly toolResultBlocksObserved: number;
  readonly toolResultBlocksCompressed: number;
  readonly dynamicReduction: number | undefined;
  readonly upstreamErrors: number;
  /**
   * Counted from the EVIDENCE LEDGER, not the gateway's in-process counter.
   *
   * The MCP retrieval server is a separate process the agent starts, so a gateway counter is
   * zero by construction. Reporting that zero in the panel would tell a user retrieval never
   * happened while the ledger recorded a delivered retrieval — v0.4.0 hit this exact bug in
   * its benchmark and fixed it the same way.
   */
  readonly retrievalsDelivered: number;
  readonly retrievalsWithheld: number;
  readonly cleanupStatus: "not-started" | "in-progress" | "complete" | "failed";
  /** Free-text notes safe for display. Never a path, credential, or prompt. */
  readonly notes: readonly string[];
}

export interface NativeClaudeGuiSession {
  readonly sessionId: string;
  readonly state: NativeSessionState;

  readonly sourceWorkspaceId: string;
  readonly preparedWorkspace: string;

  readonly gatewayUrl: string;
  readonly contextRoot: string;
  readonly evidenceRoot: string;

  readonly userDataDir: string;
  readonly extensionsDir: string;
  readonly profileName: string;

  readonly deliveryMode: DeliveryMode;
  readonly privacyMode: PrivacyMode;
  readonly retrievalMode: RetrievalMode;

  readonly claudeExtension: {
    readonly id: string;
    readonly version: string;
  };

  getStats(): Promise<DynamicContextStats>;
  getDiagnostics(): Promise<NativeSessionDiagnostics>;
  focus(): Promise<void>;
  close(reason: NativeSessionCloseReason): Promise<void>;
}

/**
 * The public session record. Everything here may be read by a UI, written to a log, or
 * exported in diagnostics, so it carries identifiers and never content: no absolute path,
 * no filename that could name a person, no token, no prompt. CLAUDE.md conflict #4.
 */
export interface PublicSessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly state: NativeSessionState;
  readonly clientSurface: ClientSurface;
  readonly workspaceHash: string;
  readonly sourceWorkspaceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliveryMode: DeliveryMode;
  readonly privacyMode?: PrivacyMode;
  readonly retrievalMode: RetrievalMode;
  readonly claudeExtensionId: string | undefined;
  readonly claudeExtensionVersion: string | undefined;
  readonly vscodeVersion: string | undefined;
  readonly integrationPath: "official-setting" | "process-env-fallback" | undefined;
  readonly closeReason: NativeSessionCloseReason | undefined;
}

export interface LifecycleEvent {
  readonly ts: string;
  readonly sessionId: string;
  readonly from: NativeSessionState | undefined;
  readonly to: NativeSessionState;
  readonly reason: string | undefined;
}

/** Environment handed to the official extension. Never contains a credential. */
export interface NativeGuiEnvironment {
  readonly ANTHROPIC_BASE_URL: string;
  readonly YUHI_SESSION_ID: string;
  readonly YUHI_CONTEXT_ROOT: string;
  readonly YUHI_DYNAMIC_CONTEXT: "1";
  readonly YUHI_CLIENT_SURFACE: ClientSurface;
  readonly YUHI_DELIVERY_MODE: DeliveryMode;
  readonly YUHI_PRIVACY_MODE: PrivacyMode;
  readonly YUHI_RETRIEVAL_MODE: RetrievalMode;
}

/** The keys Yuhi owns inside `claudeCode.environmentVariables`. Nothing else is touched. */
export const YUHI_MANAGED_ENV_KEYS: readonly (keyof NativeGuiEnvironment)[] = [
  "ANTHROPIC_BASE_URL",
  "YUHI_SESSION_ID",
  "YUHI_CONTEXT_ROOT",
  "YUHI_DYNAMIC_CONTEXT",
  "YUHI_CLIENT_SURFACE",
  "YUHI_DELIVERY_MODE",
  "YUHI_PRIVACY_MODE",
  "YUHI_RETRIEVAL_MODE",
];

export function nativeGuiEnvironment(input: {
  gatewayUrl: string;
  sessionId: string;
  contextRoot: string;
  deliveryMode: DeliveryMode;
  privacyMode: PrivacyMode;
  retrievalMode: RetrievalMode;
}): NativeGuiEnvironment {
  return {
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    YUHI_SESSION_ID: input.sessionId,
    YUHI_CONTEXT_ROOT: input.contextRoot,
    YUHI_DYNAMIC_CONTEXT: "1",
    YUHI_CLIENT_SURFACE: "native-gui",
    YUHI_DELIVERY_MODE: input.deliveryMode,
    YUHI_PRIVACY_MODE: input.privacyMode,
    YUHI_RETRIEVAL_MODE: input.retrievalMode,
  };
}

/**
 * Shown when Yuhi had to fall back to injecting the endpoint into the whole isolated VS Code
 * process. It is a real difference in blast radius — every child of that window inherits it,
 * not just `claude` — so it is stated rather than smoothed over.
 */
export const PROCESS_ENV_FALLBACK_WARNING =
  "Claude Code is using process-wide Gateway environment in this isolated Window.";

export class NativeSessionError extends Error {
  constructor(
    readonly reason:
      | "no-vscode-executable"
      | "vscode-launch-failed"
      | "extension-contract-broken"
      | "extension-install-failed"
      | "attach-timeout"
      | "gateway-start-failed"
      | "workspace-unresolved"
      | "session-locked"
      | "remote-unsupported"
      | "platform-unsupported",
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "NativeSessionError";
  }
}
