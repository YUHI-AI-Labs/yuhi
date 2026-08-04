/**
 * Finding and clearing sessions that outlived the thing that owned them.
 *
 * A crash, a force-quit, or a machine restart can leave a session directory whose gateway is
 * gone, or — worse — whose gateway is still listening with nothing attached. Recovery scans
 * the sessions root, classifies each one, and offers to finish the shutdown.
 *
 * The rule this file exists to enforce: **never touch a process that is not ours.** A stale
 * PID can be recycled by anything. A session is only eligible for process-level cleanup when
 * its lock's workspace hash and session id match the directory it was found in, and even
 * then only the gateway port is closed — no signal is ever sent to a VS Code the user may
 * still be using.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanupSession, purgeSessionDirectory } from "./cleanup.js";
import { evaluateLock, readLock, type LockEnvironment, type StaleReason, defaultLockEnvironment } from "./session-lock.js";
import { nativeSessionsRoot, sessionLayout, type SessionLayout } from "./session-layout.js";
import { isTerminal, type NativeSessionState, type PublicSessionRecord } from "./types.js";

export type SessionHealth = "live" | "stale" | "finished" | "unreadable";

export interface DiscoveredSession {
  readonly sessionId: string;
  readonly layout: SessionLayout;
  readonly record: PublicSessionRecord | undefined;
  readonly health: SessionHealth;
  readonly staleReason: StaleReason | undefined;
  readonly gatewayReachable: boolean | undefined;
  readonly ownerPid: number | undefined;
}

export interface RecoveryEnvironment extends LockEnvironment {
  /** Probe a gateway's `/readyz`. Undefined result means "not checked". */
  readonly probeGateway?: (url: string) => Promise<boolean>;
  readonly root?: string;
}

async function readRecord(file: string): Promise<PublicSessionRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const raw = parsed as Record<string, unknown>;
    if (raw["schemaVersion"] !== 1 || typeof raw["sessionId"] !== "string") return undefined;
    return raw as unknown as PublicSessionRecord;
  } catch {
    return undefined;
  }
}

/** The gateway endpoint, kept in `private/` so it never reaches a public record. */
async function readGatewayUrl(layout: SessionLayout): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(layout.gatewayDir, "endpoint.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const url = (parsed as Record<string, unknown>)["url"];
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverSessions(env: RecoveryEnvironment = defaultLockEnvironment): Promise<DiscoveredSession[]> {
  const root = env.root ?? nativeSessionsRoot();
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const found: DiscoveredSession[] = [];
  for (const sessionId of entries) {
    const layout = sessionLayout(sessionId, root);
    const record = await readRecord(layout.sessionRecord);
    const lock = await readLock(layout.lockFile);
    const verdict = evaluateLock(lock, env);

    let gatewayReachable: boolean | undefined;
    if (env.probeGateway) {
      const url = await readGatewayUrl(layout);
      gatewayReachable = url ? await env.probeGateway(`${url}/readyz`).catch(() => false) : false;
    }

    let health: SessionHealth;
    let staleReason: StaleReason | undefined;
    if (!record && !lock) {
      health = "unreadable";
    } else if (record && isTerminal(record.state) && verdict.kind !== "held") {
      health = "finished";
    } else if (verdict.kind === "held") {
      health = "live";
    } else if (verdict.kind === "stale") {
      health = "stale";
      staleReason = verdict.why;
    } else {
      // No lock at all, but a non-terminal record: the owner died before releasing it.
      health = record && !isTerminal(record.state) ? "stale" : "finished";
      staleReason = health === "stale" ? "pid-gone" : undefined;
    }

    // A gateway still answering under a stale lock is the case that most needs closing.
    if (health === "stale" && gatewayReachable === true) staleReason = staleReason ?? "heartbeat-expired";

    found.push({
      sessionId,
      layout,
      record,
      health,
      staleReason,
      gatewayReachable,
      ownerPid: lock?.ownerPid,
    });
  }
  return found;
}

export interface RecoverySweepResult {
  readonly inspected: number;
  readonly recovered: readonly string[];
  readonly failed: readonly string[];
  readonly skippedLive: readonly string[];
}

/**
 * Clean up everything stale, leave everything live alone.
 *
 * `purgeFinished` removes the directories of sessions that already closed properly. It is
 * opt-in because those directories are the only record of what happened, and a user
 * diagnosing yesterday's session should still find its lifecycle log.
 */
export async function recoverStaleSessions(
  options: { env?: RecoveryEnvironment; purgeFinished?: boolean } = {},
): Promise<RecoverySweepResult> {
  const env = options.env ?? defaultLockEnvironment;
  const sessions = await discoverSessions(env);
  const recovered: string[] = [];
  const failed: string[] = [];
  const skippedLive: string[] = [];

  for (const session of sessions) {
    if (session.health === "live") {
      skippedLive.push(session.sessionId);
      continue;
    }
    if (session.health === "finished") {
      if (options.purgeFinished) await purgeSessionDirectory(session.layout).catch(() => {});
      continue;
    }
    // Stale or unreadable: finish the shutdown that never completed. No signal is sent to
    // any process — we only release our own artefacts.
    const result = await cleanupSession(session.layout, {});
    if (result.ok) recovered.push(session.sessionId);
    else failed.push(session.sessionId);
  }

  return { inspected: sessions.length, recovered, failed, skippedLive };
}

export function summariseHealth(session: DiscoveredSession): string {
  const state: NativeSessionState = session.record?.state ?? "orphaned";
  switch (session.health) {
    case "live":
      return `active (${state})`;
    case "stale":
      return `stale (${state}${session.staleReason ? `, ${session.staleReason}` : ""})`;
    case "finished":
      return `finished (${state})`;
    default:
      return "unreadable";
  }
}
