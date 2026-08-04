/**
 * The isolated window's side of the handshake, and the originating window's control channel.
 *
 * Both live here because they speak the same token-guarded loopback protocol; only the
 * routes differ. Neither imports `vscode`, so both are unit-testable without an editor.
 *
 * The bootstrap token is read from `private/bootstrap-token` (0o600) rather than passed
 * through settings or the environment. A session id travels in settings and in diagnostics;
 * treating it as authorisation would mean publishing the key.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface NativeSessionSettingValue {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly controlUrl?: string;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function readBootstrapToken(sessionRoot: string): Promise<string | undefined> {
  try {
    return (await readFile(join(sessionRoot, "private", "bootstrap-token"), "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function post(fetcher: Fetcher, url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  return { ok: res.ok, status: res.status, data };
}

export interface AttachClientOptions {
  readonly setting: NativeSessionSettingValue;
  readonly clientInstanceId: string;
  readonly yuhiExtensionVersion: string;
  readonly vscodeVersion: string;
  readonly claudeExtensionVersion: string;
  readonly preparedWorkspaceHash: string;
  readonly fetcher?: Fetcher;
  readonly setTimer?: (fn: () => void, ms: number) => { dispose(): void };
  readonly onLost?: (status: number) => void;
}

export interface AttachClient {
  attach(): Promise<boolean>;
  /** Told once the official Claude panel is open, so the broker can move to `active`. */
  setClaudeReady(ready: boolean): void;
  startHeartbeat(): void;
  detach(reason: string): Promise<void>;
  dispose(): void;
}

const defaultFetcher: Fetcher = (url, init) => (globalThis.fetch as unknown as Fetcher)(url, init);

function defaultTimer(fn: () => void, ms: number): { dispose(): void } {
  const handle = setInterval(fn, ms);
  return { dispose: () => clearInterval(handle) };
}

export function createAttachClient(options: AttachClientOptions): AttachClient {
  const fetcher = options.fetcher ?? defaultFetcher;
  const timer = options.setTimer ?? defaultTimer;
  const base = options.setting.controlUrl;
  let ticker: { dispose(): void } | undefined;
  let token: string | undefined;
  let claudeReady = false;

  return {
    async attach() {
      if (!base) return false;
      token = await readBootstrapToken(options.setting.sessionRoot);
      if (!token) return false;
      const result = await post(fetcher, `${base}/attach`, {
        sessionId: options.setting.sessionId,
        bootstrapToken: token,
        preparedWorkspaceHash: options.preparedWorkspaceHash,
        clientInstanceId: options.clientInstanceId,
        yuhiExtensionVersion: options.yuhiExtensionVersion,
        vscodeVersion: options.vscodeVersion,
        claudeExtensionVersion: options.claudeExtensionVersion,
      });
      return result.ok;
    },
    setClaudeReady(ready: boolean) {
      claudeReady = ready;
    },
    startHeartbeat() {
      if (!base || !token) return;
      ticker?.dispose();
      ticker = timer(() => {
        void post(fetcher, `${base}/heartbeat`, {
          bootstrapToken: token,
          clientInstanceId: options.clientInstanceId,
          claudeReady,
        }).then((r) => {
          // A rejected heartbeat means the broker no longer recognises us. Stop beating
          // rather than hammering a socket that will keep refusing.
          if (!r.ok) {
            ticker?.dispose();
            options.onLost?.(r.status);
          }
        }).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
    },
    async detach(reason) {
      ticker?.dispose();
      if (!base || !token) return;
      await post(fetcher, `${base}/detach`, { bootstrapToken: token, reason }).catch(() => {});
    },
    dispose() {
      ticker?.dispose();
    },
  };
}

/** Used by the ORIGINATING window to inspect, focus or stop a broker-owned session. */
export interface ControlClient {
  status(): Promise<Record<string, unknown> | undefined>;
  stop(reason: string): Promise<boolean>;
  focus(): Promise<boolean>;
}

export function createControlClient(setting: NativeSessionSettingValue, fetcher: Fetcher = defaultFetcher): ControlClient {
  const base = setting.controlUrl;
  const withToken = async (): Promise<string | undefined> => readBootstrapToken(setting.sessionRoot);
  return {
    async status() {
      const token = await withToken();
      if (!base || !token) return undefined;
      const r = await post(fetcher, `${base}/status`, { bootstrapToken: token }).catch(() => undefined);
      return r?.ok ? (r.data as Record<string, unknown>) : undefined;
    },
    async stop(reason) {
      const token = await withToken();
      if (!base || !token) return false;
      const r = await post(fetcher, `${base}/stop`, { bootstrapToken: token, reason }).catch(() => undefined);
      return r?.ok === true;
    },
    async focus() {
      const token = await withToken();
      if (!base || !token) return false;
      const r = await post(fetcher, `${base}/focus`, { bootstrapToken: token }).catch(() => undefined);
      return r?.ok === true;
    },
  };
}
