/**
 * The broker entry point.
 *
 * Runs as its own detached process so session ownership survives what the extension host
 * does not: a window reload, a crash, or the user closing the originating window. It starts
 * the session, keeps the lock warm, and exits once the session closes — leaving no gateway
 * behind, which is the one outcome that must never happen.
 *
 * Invoked as: `node broker.js <config.json>` where the config is written by the caller into
 * the session's private directory and deleted once read.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeliveryMode } from "@yuhi/context-runtime";
import type { PrivacyMode } from "@yuhi/shared";

import type { RetrievalMode } from "../anthropic/transform.js";
import { startNativeClaudeGuiSession } from "./native-session.js";
import { HEARTBEAT_INTERVAL_MS } from "./heartbeat.js";
import { sessionLayout } from "./session-layout.js";
import { touchLock } from "./session-lock.js";

export interface BrokerConfig {
  readonly sourceWorkspace: string;
  readonly preparedWorkspace: string;
  /** LEGACY, superseded by `privacyMode` (v0.4.8) — ignored when `privacyMode` is given. */
  readonly deliveryMode: DeliveryMode;
  readonly privacyMode?: PrivacyMode;
  readonly privacyModeAcknowledged?: boolean;
  readonly retrievalMode: RetrievalMode;
  readonly extensionVersion?: string;
  readonly vscodeExecutable?: string;
  readonly yuhiExtensionRef?: string;
  readonly mcpServerScript?: string;
  readonly sessionsRoot?: string;
  /** Where the broker reports its control endpoint back to the originating window. */
  readonly handshakeFile: string;
}

/** `dist/native-broker.js` and `dist/native-mcp.js` are siblings in the VSIX. */
function defaultMcpServerScript(): string {
  const self = process.argv[1] ?? "";
  return self ? join(dirname(self), "native-mcp.js") : "";
}

export async function runBroker(config: BrokerConfig): Promise<void> {
  const session = await startNativeClaudeGuiSession(
    {
      sourceWorkspace: config.sourceWorkspace,
      preparedWorkspace: config.preparedWorkspace,
      deliveryMode: config.deliveryMode,
      ...(config.privacyMode ? { privacyMode: config.privacyMode } : {}),
      ...(config.privacyModeAcknowledged === undefined
        ? {}
        : { privacyModeAcknowledged: config.privacyModeAcknowledged }),
      retrievalMode: config.retrievalMode,
      ...(config.extensionVersion ? { extensionVersion: config.extensionVersion } : {}),
      ...(config.vscodeExecutable ? { vscodeExecutable: config.vscodeExecutable } : {}),
      ...(config.yuhiExtensionRef ? { yuhiExtensionRef: config.yuhiExtensionRef } : {}),
      // Default to the sibling bundle: broker and MCP server ship in the same dist/.
      mcpServerScript: config.mcpServerScript ?? defaultMcpServerScript(),
    },
    {
      ...(config.sessionsRoot ? { sessionsRoot: config.sessionsRoot } : {}),
      log: (line) => process.stdout.write(`${line}\n`),
    },
  );

  const layout = sessionLayout(session.sessionId, config.sessionsRoot);
  // The originating window learns the session id and control endpoint from this file. It
  // carries no token: the token stays 0o600 in private/ and is read directly by that window.
  await writeFile(
    config.handshakeFile,
    `${JSON.stringify({ sessionId: session.sessionId, sessionRoot: layout.root, pid: process.pid }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  // Keep the lock warm even before the isolated window attaches, so a recovery sweep during
  // a slow first-run extension download does not mistake a starting session for a dead one.
  const keepAlive = setInterval(() => {
    void touchLock(layout.lockFile, new Date().toISOString());
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (reason: "user-request" | "extension-host-shutdown"): Promise<void> => {
    clearInterval(keepAlive);
    await session.close(reason).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("user-request"));
  process.on("SIGINT", () => void shutdown("user-request"));

  // The broker's whole job is to outlive the caller and then stop cleanly.
  await session.attached.catch(() => {});
  const poll = setInterval(() => {
    if (session.state === "closed" || session.state === "failed" || session.state === "cleanup-failed") {
      clearInterval(poll);
      clearInterval(keepAlive);
      process.exit(0);
    }
  }, 1_000);
}

export async function brokerMain(argv: readonly string[]): Promise<void> {
  const configPath = argv[0];
  if (!configPath) throw new Error("broker: missing config path");
  const config = JSON.parse(await readFile(configPath, "utf8")) as BrokerConfig;
  await rm(configPath, { force: true });
  await runBroker(config);
}
