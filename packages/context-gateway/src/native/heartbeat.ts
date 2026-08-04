/**
 * Liveness for a session whose owner lives in someone else's process.
 *
 * The Yuhi extension inside the isolated window beats every 5 s; the broker declares the
 * window gone after 30 s of silence. The gap is deliberate: a VS Code extension host reload
 * takes a few seconds and is completely normal, and a monitor that tore the gateway down on
 * the first missed beat would make reloading the window destroy the session.
 */

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from "./session-lock.js";

export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS };

export interface HeartbeatMonitorOptions {
  readonly timeoutMs?: number;
  readonly checkIntervalMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { dispose(): void };
  /** Called once when the window has been silent past the timeout. */
  readonly onTimeout: () => void;
}

export interface HeartbeatMonitor {
  beat(): void;
  lastBeatAt(): number | undefined;
  silentFor(): number | undefined;
  /** Suspend expiry while a known-slow step runs (extension install, first-run download). */
  pause(): void;
  resume(): void;
  dispose(): void;
}

function defaultTimer(fn: () => void, ms: number): { dispose(): void } {
  const handle = setInterval(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return { dispose: () => clearInterval(handle) };
}

export function startHeartbeatMonitor(options: HeartbeatMonitorOptions): HeartbeatMonitor {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const checkMs = options.checkIntervalMs ?? Math.max(1_000, Math.floor(timeoutMs / 6));
  const timer = options.setTimer ?? defaultTimer;

  let last: number | undefined;
  let paused = false;
  let fired = false;

  const ticker = timer(() => {
    if (paused || fired || last === undefined) return;
    if (now() - last > timeoutMs) {
      fired = true;
      options.onTimeout();
    }
  }, checkMs);

  return {
    beat: () => {
      last = now();
      // A beat after a timeout does not resurrect the session; the broker has already acted.
    },
    lastBeatAt: () => last,
    silentFor: () => (last === undefined ? undefined : now() - last),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      last = now();
    },
    dispose: () => ticker.dispose(),
  };
}

/**
 * How long to wait for the isolated window to attach before giving up.
 *
 * Generous on purpose: a cold VS Code start plus a first-run extension activation is slow,
 * and the failure mode of waiting too long (a spinner) is far better than the failure mode
 * of giving up too early (a gateway torn down under a window that was about to connect).
 */
export const ATTACH_TIMEOUT_MS = 120_000;
