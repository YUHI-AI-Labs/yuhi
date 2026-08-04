/**
 * Starting one Native Claude GUI session, end to end.
 *
 * The whole file is orchestration. It starts no gateway of its own, defines no policy, and
 * knows nothing about secrets: `startDynamicClaudeSession` — the same call behind
 * `yuhi launch claude --dynamic-context` and Dynamic Terminal Mode — provides the gateway,
 * the delivery policy, the retrieval mode, the metrics and the evidence ledger. What is
 * added here is the isolated VS Code environment and the lifecycle around it.
 *
 * One deliberate deviation from the v0.4.1 directive's directory sketch: the context store,
 * prefix state and evidence ledger stay where the shared launcher puts them, inside the
 * Prepared Workspace at `<prepared>/.yuhi/context`. Relocating them under the session
 * directory would mean either forking `startDynamicClaudeSession` or lying to it about the
 * store root, and either one splits the runtime that §3 requires all three surfaces to
 * share. The session's `private/` holds what is genuinely session-scoped: the bootstrap
 * token, the gateway endpoint, the source binding and auth state.
 */

import { writeFile } from "node:fs/promises";

import type { DeliveryMode } from "@yuhi/context-runtime";

import { startDynamicClaudeSession, type DynamicClaudeSession, type DynamicContextStats } from "../launch-session.js";
import { startAttachServer, type AttachPayload, type AttachServerHandle } from "./attach-server.js";
import { cleanupSession } from "./cleanup.js";
import {
  describeContractFailure,
  validateExtensionContract,
  type ContractResult,
  TESTED_EXTENSION_VERSION,
} from "./extension-contract.js";
import { ATTACH_TIMEOUT_MS, startHeartbeatMonitor, type HeartbeatMonitor } from "./heartbeat.js";
import { LifecycleRecorder } from "./lifecycle.js";
import {
  createSessionTree,
  newBootstrapToken,
  newSessionId,
  sessionLayout,
  workspaceHash,
  writeBootstrapToken,
  type SessionLayout,
} from "./session-layout.js";
import { touchLock, writeLock, type SessionLock } from "./session-lock.js";
import { applyManagedSettings, yuhiProfileDefaults, NATIVE_SESSION_SETTING } from "./settings-merge.js";
import {
  detectRemote,
  fileExists,
  resolveVsCode,
  REMOTE_UNSUPPORTED_MESSAGE,
  NO_EXECUTABLE_MESSAGE,
  type ResolverEnvironment,
} from "./vscode-resolver.js";
import {
  focusIsolatedWindow,
  installOfficialExtension,
  installYuhiExtension,
  launchIsolatedWindow,
  listInstalledExtensions,
  nodeProcessRunner,
  readIsolatedManifest,
  readVsCodeVersion,
  YUHI_PROFILE_NAME,
  YUHI_TITLE_BAR_ACCENT,
  type ProcessRunner,
} from "./vscode-launcher.js";
import {
  nativeGuiEnvironment,
  NativeSessionError,
  type NativeClaudeGuiSession,
  type NativeSessionCloseReason,
  type NativeSessionDiagnostics,
  type StartNativeClaudeGuiOptions,
} from "./types.js";

export interface NativeSessionDependencies {
  readonly runner?: ProcessRunner;
  readonly resolver?: ResolverEnvironment;
  readonly startGatewaySession?: typeof startDynamicClaudeSession;
  readonly startAttach?: typeof startAttachServer;
  readonly listExtensionsDir?: (dir: string) => Promise<readonly string[]>;
  readonly sessionsRoot?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly attachTimeoutMs?: number;
  /** Ask the user whether to install the official extension. Default: install. */
  readonly confirmInstall?: (version: string) => Promise<boolean>;
  readonly onStateChange?: (state: string) => void;
}

export interface StartedNativeSession extends NativeClaudeGuiSession {
  /** Resolves once the isolated window has attached, or rejects on timeout. */
  readonly attached: Promise<AttachPayload>;
}

export async function startNativeClaudeGuiSession(
  options: StartNativeClaudeGuiOptions,
  deps: NativeSessionDependencies = {},
): Promise<StartedNativeSession> {
  const runner = deps.runner ?? nodeProcessRunner;
  const log = deps.log ?? ((): void => {});
  const nowMs = deps.now ?? (() => Date.now());
  const iso = (): string => new Date(nowMs()).toISOString();

  const resolverEnv: ResolverEnvironment = deps.resolver ?? {
    platform: process.platform,
    env: process.env,
    exists: fileExists,
    which: async (cmd) => {
      try {
        const r = await runner.run({ file: process.platform === "win32" ? "where" : "which", args: [cmd], timeoutMs: 10_000 });
        const first = r.stdout.split("\n")[0]?.trim();
        return r.code === 0 && first ? first : undefined;
      } catch {
        return undefined;
      }
    },
    home: process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
  };

  // ---- preflight ---------------------------------------------------------
  const remote = detectRemote(resolverEnv.env);
  if (remote) throw new NativeSessionError("remote-unsupported", REMOTE_UNSUPPORTED_MESSAGE);

  const preparedWorkspace = options.preparedWorkspace ?? options.sourceWorkspace;
  const sessionId = newSessionId();
  const layout = sessionLayout(sessionId, deps.sessionsRoot);
  await createSessionTree(layout);

  const wsHash = workspaceHash(options.sourceWorkspace);
  const recorder = new LifecycleRecorder({
    sessionId,
    lifecycleLog: layout.lifecycleLog,
    sessionRecord: layout.sessionRecord,
    workspaceHash: wsHash,
    sourceWorkspaceId: workspaceHash(preparedWorkspace),
    deliveryMode: options.deliveryMode,
    retrievalMode: options.retrievalMode,
    now: iso,
    onIllegalTransition: (from, to) => log(`[native] illegal transition ${from} -> ${to}`),
  });
  const advance = async (state: Parameters<LifecycleRecorder["transition"]>[0], reason?: string): Promise<void> => {
    await recorder.transition(state, reason);
    deps.onStateChange?.(recorder.state());
  };
  await recorder.persist();
  await advance("prepared", "prepared workspace resolved");

  const candidate = await resolveVsCode(resolverEnv, options.vscodeExecutable);
  if (!candidate) {
    await advance("failed", "no vscode executable");
    throw new NativeSessionError("no-vscode-executable", NO_EXECUTABLE_MESSAGE);
  }
  const vscodeVersion = await readVsCodeVersion(runner, candidate.executable);
  recorder.describe({ vscodeVersion });

  // ---- gateway (shared runtime; nothing new) -----------------------------
  await advance("gateway-starting");
  const startSession = deps.startGatewaySession ?? startDynamicClaudeSession;
  let gateway: DynamicClaudeSession;
  try {
    gateway = await startSession({
      preparedWorkspace,
      retrievalMode: options.retrievalMode,
      deliveryMode: options.deliveryMode,
      sessionId,
      log,
    });
  } catch (err) {
    await advance("failed", "gateway start failed");
    throw new NativeSessionError("gateway-start-failed", err instanceof Error ? err.message : "unknown");
  }
  await writeFile(
    `${layout.gatewayDir}/endpoint.json`,
    `${JSON.stringify({ url: gateway.gatewayUrl, sessionId }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await advance("gateway-ready");

  // ---- isolated profile --------------------------------------------------
  await advance("profile-provisioning");
  const managedEnv = nativeGuiEnvironment({
    gatewayUrl: gateway.gatewayUrl,
    sessionId,
    contextRoot: gateway.contextRoot,
    deliveryMode: options.deliveryMode,
    retrievalMode: options.retrievalMode,
  });

  const isolation = {
    userDataDir: layout.userDataDir,
    extensionsDir: layout.extensionsDir,
    profileName: YUHI_PROFILE_NAME,
  };

  // ---- official extension: validate, install if needed, validate again ----
  const lister = deps.listExtensionsDir ?? (async (dir: string) => (await import("node:fs/promises")).readdir(dir));
  let manifest = await readIsolatedManifest(layout.extensionsDir, lister);
  let contract: ContractResult = validateExtensionContract(manifest);

  if (!contract.ok && contract.failures.includes("not-installed")) {
    const wanted = options.extensionVersion ?? TESTED_EXTENSION_VERSION;
    const approved = deps.confirmInstall ? await deps.confirmInstall(wanted) : true;
    if (!approved) {
      await cleanupSession(layout, { closeGateway: () => void gateway.close() });
      await advance("failed", "extension install declined");
      throw new NativeSessionError("extension-install-failed", "The official Claude Code extension is required in the isolated Yuhi profile.");
    }
    await advance("extension-installing");
    const install = await installOfficialExtension(runner, candidate.executable, isolation, wanted);
    if (!install.ok) {
      await cleanupSession(layout, { closeGateway: () => void gateway.close() });
      await advance("failed", "extension install failed");
      throw new NativeSessionError("extension-install-failed", install.output.slice(0, 500));
    }
    manifest = await readIsolatedManifest(layout.extensionsDir, lister);
    contract = validateExtensionContract(manifest);
  }

  if (!contract.ok) {
    await cleanupSession(layout, { closeGateway: () => void gateway.close() });
    await advance("failed", "extension contract broken");
    throw new NativeSessionError("extension-contract-broken", describeContractFailure(contract));
  }
  // Yuhi must be present in the isolated window too, or nothing attaches and the official
  // panel never opens. Installed after the contract check so a broken Claude extension fails
  // fast instead of after a second download.
  const yuhiInstalled = await listInstalledExtensions(runner, candidate.executable, isolation);
  if (!yuhiInstalled.some((e) => e.toLowerCase().startsWith("yuhi-ai-labs.yuhi-vscode@"))) {
    await advance("extension-installing", "installing Yuhi into the isolated window");
    const self = await installYuhiExtension(runner, candidate.executable, isolation, options.yuhiExtensionRef);
    if (!self.ok) {
      await cleanupSession(layout, { closeGateway: () => void gateway.close() });
      await advance("failed", "yuhi self-install failed");
      throw new NativeSessionError("extension-install-failed", self.output.slice(0, 500));
    }
  }

  recorder.describe({
    claudeExtensionId: "Anthropic.claude-code",
    claudeExtensionVersion: contract.version,
    integrationPath: "official-setting",
  });

  // ---- the official setting, merged (never overwritten) ------------------
  // Written before the attach server exists; the control URL is patched in below once the
  // port is known. The isolated window's Yuhi extension reads this to know it is a Native
  // GUI window at all — under the official-setting path its extension host receives no
  // Yuhi environment, so a setting is the only channel it has.
  await applyManagedSettings({
    settingsFile: profileSettingsPath(layout),
    managed: managedEnv,
    defaults: yuhiProfileDefaults(YUHI_TITLE_BAR_ACCENT),
    overrides: { [NATIVE_SESSION_SETTING]: { sessionId, sessionRoot: layout.root } },
  });

  // ---- attach server + lock ---------------------------------------------
  const token = newBootstrapToken();
  await writeBootstrapToken(layout, token);

  let heartbeat: HeartbeatMonitor | undefined;
  let attachResolve: (p: AttachPayload) => void = () => {};
  let attachReject: (e: Error) => void = () => {};
  const attached = new Promise<AttachPayload>((resolve, reject) => {
    attachResolve = resolve;
    attachReject = reject;
  });

  const startAttachImpl = deps.startAttach ?? startAttachServer;
  const attachServer: AttachServerHandle = await startAttachImpl(
    {
      sessionId,
      bootstrapToken: token,
      preparedWorkspaceHash: workspaceHash(preparedWorkspace),
      ...(contract.version ? { expectedClaudeExtensionVersion: contract.version } : {}),
    },
    {
      onAttach: (payload) => {
        void (async () => {
          await advance("vscode-attached", "window attached");
          heartbeat?.beat();
          attachResolve(payload);
          await advance("claude-activating");
        })();
      },
      onHeartbeat: (_id, _client, claudeReady) => {
        heartbeat?.beat();
        void touchLock(layout.lockFile, iso());
        // The window reports when the official panel is actually open. Yuhi does not claim
        // `active` on its own timer — a session that says "ready" while the panel failed to
        // open would make the status bar lie about the thing the user is looking at.
        if (claudeReady && recorder.state() === "claude-activating") {
          void (async () => {
            await advance("claude-ready", "official Claude panel open");
            await advance("active");
          })();
        }
      },
      onDetach: (_id, reason) => {
        void close(reason === "window-closed" ? "window-closed" : "extension-host-shutdown");
      },
      // Control plane for the originating window. Same token guard as heartbeat.
      onStatus: async () => ({ ...(await diagnose()) }),
      onStop: async (reason) => {
        // Kick off the shutdown but answer first. Awaiting it here tears down this very
        // server before the reply is written, so the caller sees a dropped connection and
        // cannot distinguish "stopped" from "unreachable".
        void close(reason === "window-closed" ? "window-closed" : "user-request");
      },
      onFocus: async () => {
        await focusIsolatedWindow(runner, { executable: candidate.executable, preparedWorkspace, ...isolation });
      },
    },
  );
  await applyManagedSettings({
    settingsFile: profileSettingsPath(layout),
    managed: managedEnv,
    overrides: {
      [NATIVE_SESSION_SETTING]: { sessionId, sessionRoot: layout.root, controlUrl: attachServer.url },
    },
  });
  await writeFile(
    `${layout.privateDir}/attach-endpoint.json`,
    `${JSON.stringify({ url: attachServer.url }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const lock: SessionLock = {
    schemaVersion: 1,
    sessionId,
    workspaceHash: wsHash,
    ownerPid: process.pid,
    createdAt: iso(),
    heartbeatAt: iso(),
    state: "vscode-launching",
  };
  await writeLock(layout.lockFile, lock);

  // ---- launch ------------------------------------------------------------
  await advance("vscode-launching");
  launchIsolatedWindow(runner, {
    executable: candidate.executable,
    preparedWorkspace,
    ...isolation,
  });
  await advance("vscode-started");
  await advance("vscode-attaching");

  const attachTimeout = deps.attachTimeoutMs ?? ATTACH_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (attachServer.attached()) return;
    attachReject(new NativeSessionError("attach-timeout", "The isolated window did not connect to Yuhi in time."));
    void close("attach-timeout");
  }, attachTimeout);
  if (typeof timer.unref === "function") timer.unref();
  void attached.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));

  heartbeat = startHeartbeatMonitor({
    now: nowMs,
    onTimeout: () => {
      log("[native] window heartbeat expired; closing the session.");
      void close("heartbeat-timeout");
    },
  });

  // ---- close (idempotent) ------------------------------------------------
  let closing: Promise<void> | undefined;
  let cleanupStatus: NativeSessionDiagnostics["cleanupStatus"] = "not-started";
  let lastStats: DynamicContextStats | undefined;

  async function close(reason: NativeSessionCloseReason): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      cleanupStatus = "in-progress";
      await recorder.transition("closing", reason, reason);
      const result = await cleanupSession(layout, {
        stopHeartbeat: () => heartbeat?.dispose(),
        stopAttachServer: () => attachServer.close(),
        closeGateway: async () => {
          lastStats = await gateway.close();
        },
      });
      cleanupStatus = result.ok ? "complete" : "failed";
      await recorder.transition(result.ok ? "closed" : "cleanup-failed", reason, reason);
      deps.onStateChange?.(recorder.state());
      if (!result.ok) {
        const failed = result.steps.filter((s) => !s.ok).map((s) => s.step);
        log(`[native] cleanup incomplete: ${failed.join(", ")}`);
      }
    })();
    return closing;
  }

  const session: StartedNativeSession = {
    sessionId,
    get state() {
      return recorder.state();
    },
    sourceWorkspaceId: workspaceHash(preparedWorkspace),
    preparedWorkspace,
    gatewayUrl: gateway.gatewayUrl,
    contextRoot: gateway.contextRoot,
    evidenceRoot: gateway.contextRoot,
    userDataDir: layout.userDataDir,
    extensionsDir: layout.extensionsDir,
    profileName: YUHI_PROFILE_NAME,
    deliveryMode: options.deliveryMode,
    retrievalMode: options.retrievalMode,
    claudeExtension: { id: "Anthropic.claude-code", version: contract.version ?? "unknown" },
    attached,
    getStats: async () => {
      lastStats = await gateway.getStats();
      await writeFile(layout.statsRecord, `${JSON.stringify(lastStats, null, 2)}\n`, "utf8");
      return lastStats;
    },
    getDiagnostics: async () => diagnose(),
    focus: async () => {
      await focusIsolatedWindow(runner, { executable: candidate.executable, preparedWorkspace, ...isolation });
    },
    close,
  };

  async function diagnose(): Promise<NativeSessionDiagnostics> {
    let stats = lastStats;
    try {
      stats = await gateway.getStats();
      lastStats = stats;
    } catch {
      // Diagnostics must work on a half-dead session; a stats failure is data, not an error.
    }
    const snapshot = stats?.sessions[0];
    const silent = heartbeat?.silentFor();
    return {
      sessionId,
      state: recorder.state(),
      gatewayHealthy: stats !== undefined,
      vscodeAttached: attachServer.attached(),
      claudeExtensionVersion: contract.version,
      deliveryMode: options.deliveryMode,
      retrievalMode: options.retrievalMode,
      lastHeartbeatAt: heartbeat?.lastBeatAt() ? new Date(heartbeat.lastBeatAt() as number).toISOString() : undefined,
      requests: stats?.requests ?? 0,
      toolResultBlocksObserved: snapshot?.toolResultBlocksObserved ?? 0,
      toolResultBlocksCompressed: snapshot?.toolResultBlocksCompressed ?? 0,
      dynamicReduction: snapshot && snapshot.rawEstimatedTokens > 0 ? snapshot.dynamicReduction : undefined,
      upstreamErrors: snapshot?.upstreamErrors ?? 0,
      cleanupStatus,
      notes: silent !== undefined && silent > 10_000 ? [`window silent for ${Math.round(silent / 1000)}s`] : [],
    };
  }

  return session;
}

/**
 * The settings file VS Code reads for this isolated user-data-dir.
 *
 * Deliberately the same value cleanup uses — one source of truth. A named profile's settings
 * live under `User/profiles/<generated-id>/`, whose id is unknowable before first launch, and
 * Yuhi does not use named profiles anyway (see `vscode-launcher.isolationArgs`).
 */
function profileSettingsPath(layout: SessionLayout): string {
  return layout.profileSettings;
}

export { profileSettingsPath };
