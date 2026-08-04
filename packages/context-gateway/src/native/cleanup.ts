/**
 * Shutdown, made idempotent.
 *
 * The ordering matters more than it looks. Evidence is flushed before the gateway closes,
 * because the gateway owns the ledger writer. The bootstrap token is revoked before the lock
 * is released, so a window that reconnects in the gap cannot re-attach to a session that is
 * already tearing down. The lock is released last, because it is what a recovery sweep uses
 * to decide whether anything still needs cleaning.
 *
 * Every step is independently guarded: one failure must not strand a listening gateway,
 * which is the single worst outcome here — it would keep a loopback port open with an
 * upstream credential path behind it after the user believes they closed the session.
 */

import { rm } from "node:fs/promises";

import { clearManagedSettings } from "./settings-merge.js";
import { releaseLock } from "./session-lock.js";
import type { SessionLayout } from "./session-layout.js";

export type CleanupStepName =
  | "stop-heartbeat"
  | "stop-attach-server"
  | "flush-evidence"
  | "close-gateway"
  | "clear-settings"
  | "revoke-token"
  | "release-lock";

export interface CleanupStepResult {
  readonly step: CleanupStepName;
  readonly ok: boolean;
  readonly error?: string;
}

export interface CleanupResult {
  readonly ok: boolean;
  readonly steps: readonly CleanupStepResult[];
}

export interface CleanupHooks {
  stopHeartbeat?: () => void | Promise<void>;
  stopAttachServer?: () => void | Promise<void>;
  flushEvidence?: () => void | Promise<void>;
  closeGateway?: () => void | Promise<void>;
}

/**
 * Run every step, in order, regardless of individual failures, and report each one.
 *
 * Deliberately NOT fail-fast: aborting after a failed evidence flush would leave the gateway
 * listening. The caller decides what a partial cleanup means (it becomes `cleanup-failed`,
 * which the recovery sweep can retry).
 */
export async function cleanupSession(layout: SessionLayout, hooks: CleanupHooks): Promise<CleanupResult> {
  const steps: CleanupStepResult[] = [];

  const attempt = async (step: CleanupStepName, fn: (() => void | Promise<void>) | undefined): Promise<void> => {
    if (!fn) {
      steps.push({ step, ok: true });
      return;
    }
    try {
      await fn();
      steps.push({ step, ok: true });
    } catch (err) {
      steps.push({ step, ok: false, error: err instanceof Error ? err.name : "unknown" });
    }
  };

  await attempt("stop-heartbeat", hooks.stopHeartbeat);
  await attempt("stop-attach-server", hooks.stopAttachServer);
  await attempt("flush-evidence", hooks.flushEvidence);
  await attempt("close-gateway", hooks.closeGateway);
  await attempt("clear-settings", () => clearManagedSettings(layout.profileSettings));
  await attempt("revoke-token", () => rm(layout.bootstrapTokenFile, { force: true }));
  await attempt("release-lock", () => releaseLock(layout.lockFile));

  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * Remove a finished session's working directory.
 *
 * Separate from `cleanupSession` on purpose: tearing down the runtime is urgent, deleting
 * the directory is not, and a user inspecting why a session failed should still find its
 * lifecycle log. Callers invoke this only for sessions that closed cleanly.
 */
export async function purgeSessionDirectory(layout: SessionLayout): Promise<void> {
  await rm(layout.root, { recursive: true, force: true });
}
