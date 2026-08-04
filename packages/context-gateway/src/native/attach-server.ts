/**
 * The bootstrap handshake between the broker and the Yuhi extension inside the isolated
 * window.
 *
 * A session id is an identifier, not a capability. It appears in the isolated window's
 * environment, in public records and in diagnostics, so anything that accepted it as proof
 * of ownership would be trusting a value we deliberately publish. Authorisation is the
 * bootstrap token: 256 random bits, written 0o600 inside `private/`, compared in constant
 * time, and revoked on close.
 *
 * The server binds loopback only and speaks three routes: attach, heartbeat, detach.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface AttachPayload {
  readonly sessionId: string;
  readonly bootstrapToken: string;
  readonly preparedWorkspaceHash: string;
  readonly clientInstanceId: string;
  readonly yuhiExtensionVersion: string;
  readonly vscodeVersion: string;
  readonly claudeExtensionVersion: string;
}

export type AttachRejection =
  | "bad-token"
  | "unknown-session"
  | "workspace-mismatch"
  | "already-attached"
  | "malformed";

export interface AttachExpectation {
  readonly sessionId: string;
  readonly bootstrapToken: string;
  readonly preparedWorkspaceHash: string;
  /** When set, an attaching window whose extension version differs is refused. */
  readonly expectedClaudeExtensionVersion?: string;
}

export interface AttachOutcome {
  readonly ok: boolean;
  readonly rejection?: AttachRejection;
}

export interface AttachServerHooks {
  onAttach(payload: AttachPayload): void;
  onHeartbeat(sessionId: string, clientInstanceId: string, claudeReady: boolean): void;
  onDetach(sessionId: string, reason: string): void;
  /**
   * Control routes used by the ORIGINATING window (the normal one), not the isolated one.
   * They are token-guarded exactly like heartbeat: holding the session id is not enough to
   * stop someone's session.
   */
  onStatus?(): Promise<Record<string, unknown>>;
  onStop?(reason: string): Promise<void>;
  onFocus?(): Promise<void>;
}

export interface AttachServerHandle {
  readonly url: string;
  readonly port: number;
  attached(): boolean;
  close(): Promise<void>;
}

/** Constant-time compare that tolerates differing lengths without leaking them by timing. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still do a comparison so the failure cost does not depend on where they diverge.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function validateAttach(payload: unknown, expect: AttachExpectation, alreadyAttached: boolean): AttachOutcome {
  if (typeof payload !== "object" || payload === null) return { ok: false, rejection: "malformed" };
  const raw = payload as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);

  const sessionId = str("sessionId");
  const token = str("bootstrapToken");
  const workspaceHash = str("preparedWorkspaceHash");
  if (!sessionId || !token || !workspaceHash || !str("clientInstanceId")) {
    return { ok: false, rejection: "malformed" };
  }
  // Token first: a wrong session id with a valid token is a bug, a wrong token is an attempt.
  if (!tokensMatch(token, expect.bootstrapToken)) return { ok: false, rejection: "bad-token" };
  if (sessionId !== expect.sessionId) return { ok: false, rejection: "unknown-session" };
  if (workspaceHash !== expect.preparedWorkspaceHash) return { ok: false, rejection: "workspace-mismatch" };
  if (alreadyAttached) return { ok: false, rejection: "already-attached" };
  return { ok: true };
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error("body-too-large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startAttachServer(
  expect: AttachExpectation,
  hooks: AttachServerHooks,
): Promise<AttachServerHandle> {
  let isAttached = false;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });

      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, { error: "malformed" });
      }

      if (path === "/attach") {
        const outcome = validateAttach(body, expect, isAttached);
        if (!outcome.ok) return send(res, outcome.rejection === "bad-token" ? 403 : 409, { error: outcome.rejection });
        isAttached = true;
        hooks.onAttach(body as AttachPayload);
        return send(res, 200, { ok: true });
      }

      // Heartbeat and detach are token-guarded too: an unauthenticated caller must not be
      // able to keep a dead session's lock alive, nor tear a live one down.
      const raw = (body ?? {}) as Record<string, unknown>;
      const token = typeof raw["bootstrapToken"] === "string" ? raw["bootstrapToken"] : "";
      if (!tokensMatch(token, expect.bootstrapToken)) return send(res, 403, { error: "bad-token" });

      if (path === "/heartbeat") {
        hooks.onHeartbeat(expect.sessionId, String(raw["clientInstanceId"] ?? "unknown"), raw["claudeReady"] === true);
        return send(res, 200, { ok: true });
      }
      if (path === "/detach") {
        isAttached = false;
        hooks.onDetach(expect.sessionId, String(raw["reason"] ?? "unspecified"));
        return send(res, 200, { ok: true });
      }
      if (path === "/status" && hooks.onStatus) {
        return send(res, 200, await hooks.onStatus());
      }
      if (path === "/stop" && hooks.onStop) {
        await hooks.onStop(String(raw["reason"] ?? "user-request"));
        return send(res, 200, { ok: true });
      }
      if (path === "/focus" && hooks.onFocus) {
        await hooks.onFocus();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not-found" });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    attached: () => isAttached,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
