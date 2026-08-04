/**
 * One active Native GUI session per Original Workspace.
 *
 * Ownership is deliberately NOT decided by PID alone. PIDs are recycled, and a recycled PID
 * belonging to an unrelated process is the difference between "reuse this session" and
 * "kill something that is not ours". A lock counts as live only when the workspace hash
 * matches, the recorded PID is alive, AND the heartbeat is fresh; the gateway health check
 * is layered on top by the manager, which can actually reach the socket.
 */

import { readFile, rm, writeFile } from "node:fs/promises";

import type { NativeSessionState } from "./types.js";

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface SessionLock {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly workspaceHash: string;
  readonly ownerPid: number;
  readonly createdAt: string;
  readonly heartbeatAt: string;
  readonly state: NativeSessionState;
}

export type LockVerdict =
  | { readonly kind: "free" }
  | { readonly kind: "held"; readonly lock: SessionLock }
  | { readonly kind: "stale"; readonly lock: SessionLock; readonly why: StaleReason };

export type StaleReason = "pid-gone" | "heartbeat-expired" | "terminal-state" | "unreadable";

export interface LockEnvironment {
  readonly now: () => number;
  readonly isProcessAlive: (pid: number) => boolean;
}

export const defaultLockEnvironment: LockEnvironment = {
  now: () => Date.now(),
  isProcessAlive: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 performs the permission/existence check without delivering a signal.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists but belongs to another user — alive, and not ours to touch.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export async function readLock(file: string): Promise<SessionLock | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const raw = parsed as Record<string, unknown>;
    if (raw["schemaVersion"] !== 1) return undefined;
    if (typeof raw["sessionId"] !== "string" || typeof raw["workspaceHash"] !== "string") return undefined;
    if (typeof raw["ownerPid"] !== "number") return undefined;
    return {
      schemaVersion: 1,
      sessionId: raw["sessionId"],
      workspaceHash: raw["workspaceHash"],
      ownerPid: raw["ownerPid"],
      createdAt: String(raw["createdAt"] ?? ""),
      heartbeatAt: String(raw["heartbeatAt"] ?? ""),
      state: (raw["state"] as NativeSessionState) ?? "active",
    };
  } catch {
    return undefined;
  }
}

export async function writeLock(file: string, lock: SessionLock): Promise<void> {
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function touchLock(file: string, at: string): Promise<void> {
  const current = await readLock(file);
  if (!current) return;
  await writeLock(file, { ...current, heartbeatAt: at });
}

export async function releaseLock(file: string): Promise<void> {
  await rm(file, { force: true });
}

export function evaluateLock(
  lock: SessionLock | undefined,
  env: LockEnvironment = defaultLockEnvironment,
): LockVerdict {
  if (!lock) return { kind: "free" };
  if (lock.state === "closed" || lock.state === "failed" || lock.state === "orphaned") {
    return { kind: "stale", lock, why: "terminal-state" };
  }
  if (!env.isProcessAlive(lock.ownerPid)) return { kind: "stale", lock, why: "pid-gone" };

  const beat = Date.parse(lock.heartbeatAt);
  if (!Number.isFinite(beat)) return { kind: "stale", lock, why: "unreadable" };
  if (env.now() - beat > HEARTBEAT_TIMEOUT_MS) return { kind: "stale", lock, why: "heartbeat-expired" };

  return { kind: "held", lock };
}

/** The three ways out of a double-launch, in the order a user most often wants them. */
export const DOUBLE_LAUNCH_CHOICES = [
  "Focus existing Window",
  "Stop and restart",
  "Cancel",
] as const;

export type DoubleLaunchChoice = (typeof DOUBLE_LAUNCH_CHOICES)[number];
