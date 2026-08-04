/**
 * The broker: the thing that owns a Native GUI session, rather than the window using it.
 *
 * Ownership cannot live in the isolated window's extension host — that host is exactly what
 * disappears on a reload, a crash or a close, and a gateway whose owner vanished is the
 * failure mode this whole design exists to prevent. So the manager holds the lock, the
 * heartbeat and the cleanup, and the window is only a client that reports in.
 *
 * It also enforces the one-active-session-per-workspace contract, and turns a double launch
 * into a choice rather than a second gateway.
 */

import { startNativeClaudeGuiSession, type NativeSessionDependencies, type StartedNativeSession } from "./native-session.js";
import { discoverSessions, recoverStaleSessions, type DiscoveredSession, type RecoveryEnvironment } from "./recovery.js";
import { evaluateLock, readLock, defaultLockEnvironment, type DoubleLaunchChoice, type LockEnvironment } from "./session-lock.js";
import { nativeSessionsRoot, sessionLayout, workspaceHash } from "./session-layout.js";
import { NativeSessionError, type NativeSessionCloseReason, type StartNativeClaudeGuiOptions } from "./types.js";

export interface ExistingSessionConflict {
  readonly sessionId: string;
  readonly workspaceHash: string;
}

export interface NativeSessionManagerOptions extends NativeSessionDependencies {
  readonly lockEnv?: LockEnvironment;
  /**
   * Asked when a live session already owns this workspace. Returning undefined cancels.
   * Without a resolver the manager refuses rather than guessing — silently stopping someone
   * else's running session would be the worst possible default.
   */
  readonly onConflict?: (conflict: ExistingSessionConflict) => Promise<DoubleLaunchChoice | undefined>;
}

export class NativeSessionManager {
  private readonly sessions = new Map<string, StartedNativeSession>();

  constructor(private readonly options: NativeSessionManagerOptions = {}) {}

  /** Sessions this process currently owns. */
  active(): readonly StartedNativeSession[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): StartedNativeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every session on disk, including ones owned by other processes or already dead. */
  async list(env?: RecoveryEnvironment): Promise<DiscoveredSession[]> {
    return discoverSessions(env ?? { ...(this.options.lockEnv ?? defaultLockEnvironment), ...(this.options.sessionsRoot ? { root: this.options.sessionsRoot } : {}) });
  }

  async findLiveSessionFor(sourceWorkspace: string): Promise<ExistingSessionConflict | undefined> {
    const wanted = workspaceHash(sourceWorkspace);
    const lockEnv = this.options.lockEnv ?? defaultLockEnvironment;
    const root = this.options.sessionsRoot ?? nativeSessionsRoot();
    for (const session of await this.list({ ...lockEnv, root })) {
      const lock = await readLock(sessionLayout(session.sessionId, root).lockFile);
      if (!lock || lock.workspaceHash !== wanted) continue;
      if (evaluateLock(lock, lockEnv).kind === "held") {
        return { sessionId: lock.sessionId, workspaceHash: lock.workspaceHash };
      }
    }
    return undefined;
  }

  /**
   * Start a session, resolving a workspace conflict first.
   *
   * Returns `undefined` when the user chose to focus an existing window or cancelled — the
   * caller treats that as "nothing to do", not as a failure.
   */
  async start(options: StartNativeClaudeGuiOptions): Promise<StartedNativeSession | undefined> {
    const conflict = await this.findLiveSessionFor(options.sourceWorkspace);
    if (conflict) {
      const choice = this.options.onConflict ? await this.options.onConflict(conflict) : undefined;
      if (choice === "Focus existing Window") {
        await this.sessions.get(conflict.sessionId)?.focus();
        return undefined;
      }
      if (choice === "Stop and restart") {
        await this.stop(conflict.sessionId, "user-request");
      } else {
        throw new NativeSessionError(
          "session-locked",
          "A Native GUI session is already running for this workspace.",
        );
      }
    }

    const session = await startNativeClaudeGuiSession(options, this.options);
    this.sessions.set(session.sessionId, session);
    // Once a session finishes for any reason, stop holding a handle to it.
    void session.attached.catch(() => {});
    return session;
  }

  async stop(sessionId: string, reason: NativeSessionCloseReason): Promise<void> {
    const owned = this.sessions.get(sessionId);
    if (owned) {
      await owned.close(reason);
      this.sessions.delete(sessionId);
      return;
    }
    // Not ours: finish its shutdown from disk rather than signalling anything.
    const root = this.options.sessionsRoot ?? nativeSessionsRoot();
    const { cleanupSession } = await import("./cleanup.js");
    await cleanupSession(sessionLayout(sessionId, root), {});
  }

  async stopAll(reason: NativeSessionCloseReason): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id, reason)));
  }

  async recover(options: { purgeFinished?: boolean } = {}): ReturnType<typeof recoverStaleSessions> {
    const lockEnv = this.options.lockEnv ?? defaultLockEnvironment;
    const root = this.options.sessionsRoot ?? nativeSessionsRoot();
    return recoverStaleSessions({
      env: { ...lockEnv, root },
      ...(options.purgeFinished === undefined ? {} : { purgeFinished: options.purgeFinished }),
    });
  }
}
