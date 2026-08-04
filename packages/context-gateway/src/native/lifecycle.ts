/**
 * The session state machine and its public records.
 *
 * Transitions are validated rather than assigned freely: a session that reports `active`
 * without ever having attached would make the status bar lie, and every recovery decision
 * downstream reads these states. Illegal transitions throw in tests and are coerced to
 * `failed` at runtime, because refusing to record a state is worse than recording a wrong
 * one — the recovery sweep needs *something* to act on.
 */

import { appendFile, writeFile } from "node:fs/promises";

import type { DeliveryMode } from "@yuhi/context-runtime";

import type { RetrievalMode } from "../anthropic/transform.js";
import type {
  ClientSurface,
  LifecycleEvent,
  NativeSessionCloseReason,
  NativeSessionState,
  PublicSessionRecord,
} from "./types.js";

const ALLOWED: Record<NativeSessionState, readonly NativeSessionState[]> = {
  created: ["preparing", "prepared", "failed", "closing"],
  preparing: ["prepared", "failed", "closing"],
  prepared: ["gateway-starting", "failed", "closing"],
  "gateway-starting": ["gateway-ready", "failed", "closing"],
  "gateway-ready": ["profile-provisioning", "failed", "closing"],
  "profile-provisioning": ["extension-installing", "vscode-launching", "failed", "closing"],
  "extension-installing": ["vscode-launching", "failed", "closing"],
  "vscode-launching": ["vscode-started", "failed", "closing"],
  "vscode-started": ["vscode-attaching", "failed", "closing", "orphaned"],
  "vscode-attaching": ["vscode-attached", "failed", "closing", "orphaned"],
  "vscode-attached": ["claude-activating", "failed", "closing", "orphaned"],
  "claude-activating": ["claude-ready", "failed", "closing", "orphaned"],
  "claude-ready": ["active", "failed", "closing", "orphaned"],
  active: ["closing", "failed", "orphaned"],
  closing: ["closed", "cleanup-failed"],
  closed: [],
  failed: ["closing", "closed"],
  orphaned: ["closing", "closed", "cleanup-failed"],
  "cleanup-failed": ["closing", "closed"],
};

export function canTransition(from: NativeSessionState, to: NativeSessionState): boolean {
  return ALLOWED[from].includes(to);
}

export interface LifecycleRecorderOptions {
  readonly sessionId: string;
  readonly lifecycleLog: string;
  readonly sessionRecord: string;
  readonly workspaceHash: string;
  readonly sourceWorkspaceId: string;
  readonly deliveryMode: DeliveryMode;
  readonly retrievalMode: RetrievalMode;
  readonly clientSurface?: ClientSurface;
  readonly now?: () => string;
  readonly onIllegalTransition?: (from: NativeSessionState, to: NativeSessionState) => void;
}

export class LifecycleRecorder {
  private current: NativeSessionState = "created";
  private readonly createdAt: string;
  private readonly now: () => string;
  private claudeExtensionId: string | undefined;
  private claudeExtensionVersion: string | undefined;
  private vscodeVersion: string | undefined;
  private integrationPath: PublicSessionRecord["integrationPath"];
  private closeReason: NativeSessionCloseReason | undefined;

  constructor(private readonly options: LifecycleRecorderOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createdAt = this.now();
  }

  state(): NativeSessionState {
    return this.current;
  }

  describe(details: {
    claudeExtensionId?: string;
    claudeExtensionVersion?: string;
    vscodeVersion?: string;
    integrationPath?: PublicSessionRecord["integrationPath"];
  }): void {
    if (details.claudeExtensionId !== undefined) this.claudeExtensionId = details.claudeExtensionId;
    if (details.claudeExtensionVersion !== undefined) this.claudeExtensionVersion = details.claudeExtensionVersion;
    if (details.vscodeVersion !== undefined) this.vscodeVersion = details.vscodeVersion;
    if (details.integrationPath !== undefined) this.integrationPath = details.integrationPath;
  }

  async transition(to: NativeSessionState, reason?: string, closeReason?: NativeSessionCloseReason): Promise<void> {
    const from = this.current;
    if (from === to) return;
    if (!canTransition(from, to)) {
      this.options.onIllegalTransition?.(from, to);
      // Never drop the event: recovery needs a terminal state it can sweep.
      this.current = "failed";
      await this.append({ ts: this.now(), sessionId: this.options.sessionId, from, to: "failed", reason: `illegal-transition:${from}->${to}` });
      await this.persist();
      return;
    }
    this.current = to;
    if (closeReason) this.closeReason = closeReason;
    await this.append({ ts: this.now(), sessionId: this.options.sessionId, from, to, reason });
    await this.persist();
  }

  record(): PublicSessionRecord {
    return {
      schemaVersion: 1,
      sessionId: this.options.sessionId,
      state: this.current,
      clientSurface: this.options.clientSurface ?? "native-gui",
      workspaceHash: this.options.workspaceHash,
      sourceWorkspaceId: this.options.sourceWorkspaceId,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      deliveryMode: this.options.deliveryMode,
      retrievalMode: this.options.retrievalMode,
      claudeExtensionId: this.claudeExtensionId,
      claudeExtensionVersion: this.claudeExtensionVersion,
      vscodeVersion: this.vscodeVersion,
      integrationPath: this.integrationPath,
      closeReason: this.closeReason,
    };
  }

  async persist(): Promise<void> {
    await writeFile(this.options.sessionRecord, `${JSON.stringify(this.record(), null, 2)}\n`, "utf8");
  }

  private async append(event: LifecycleEvent): Promise<void> {
    await appendFile(this.options.lifecycleLog, `${JSON.stringify(event)}\n`, "utf8");
  }
}
