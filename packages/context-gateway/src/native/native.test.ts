import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startAttachServer, validateAttach } from "./attach-server.js";
import { cleanupSession } from "./cleanup.js";
import { exportDiagnostics, redactForExport } from "./diagnostics.js";
import { validateExtensionContract, TESTED_EXTENSION_VERSION } from "./extension-contract.js";
import { canTransition, LifecycleRecorder } from "./lifecycle.js";
import { discoverSessions, recoverStaleSessions } from "./recovery.js";
import { createSessionTree, newBootstrapToken, sessionLayout, workspaceHash, writeBootstrapToken } from "./session-layout.js";
import { evaluateLock, writeLock, type SessionLock } from "./session-lock.js";
import { applyManagedSettings, clearManagedSettings, mergeEnvironmentVariables, CLAUDE_ENV_SETTING_KEY } from "./settings-merge.js";
import { detectRemote, resolveVsCode } from "./vscode-resolver.js";
import { buildLaunchArgs } from "./vscode-launcher.js";
import { nativeGuiEnvironment } from "./types.js";

const ENV = nativeGuiEnvironment({
  gatewayUrl: "http://127.0.0.1:4242",
  sessionId: "ngui_test",
  contextRoot: "/ctx",
  deliveryMode: "developer",
  privacyMode: "balanced",
  retrievalMode: "disabled",
});

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yuhi-native-test-"));
}

// The manifest shape verified against the real Anthropic.claude-code 2.1.221 build.
function officialManifest(version = TESTED_EXTENSION_VERSION): Record<string, unknown> {
  return {
    publisher: "Anthropic",
    name: "claude-code",
    version,
    contributes: {
      configuration: {
        properties: {
          "claudeCode.environmentVariables": {
            type: "array",
            scope: "machine",
            items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] },
          },
        },
      },
      commands: [{ command: "claude-vscode.sidebar.open" }, { command: "claude-vscode.window.open" }],
    },
  };
}

describe("settings merge", () => {
  it("replaces Yuhi keys, preserves the user's own entries, and collapses duplicates", () => {
    const merged = mergeEnvironmentVariables(
      [
        { name: "MY_TOKEN_HOME", value: "one" },
        { name: "MY_TOKEN_HOME", value: "two" },
        { name: "ANTHROPIC_BASE_URL", value: "http://stale" },
        { name: "NOT_AN_ENTRY" },
      ],
      ENV,
    );
    const byName = new Map(merged.map((e) => [e.name, e.value]));
    expect(merged.filter((e) => e.name === "MY_TOKEN_HOME")).toHaveLength(1);
    expect(byName.get("MY_TOKEN_HOME")).toBe("two");
    expect(byName.get("ANTHROPIC_BASE_URL")).toBe("http://127.0.0.1:4242");
    expect(byName.get("YUHI_CLIENT_SURFACE")).toBe("native-gui");
  });

  it("never discards settings the official extension wrote itself", async () => {
    const dir = await scratch();
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ "claudeCode.preferredLocation": "sidebar", "editor.fontSize": 15 }), "utf8");
    const next = await applyManagedSettings({ settingsFile: file, managed: ENV, defaults: { "window.restoreWindows": "none" } });
    expect(next["claudeCode.preferredLocation"]).toBe("sidebar");
    expect(next["editor.fontSize"]).toBe(15);
    expect(next["window.restoreWindows"]).toBe("none");
  });

  it("overrides beat the existing file so a stale control endpoint cannot survive", async () => {
    const dir = await scratch();
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ "yuhi.nativeSession": { sessionId: "old" } }), "utf8");
    const next = await applyManagedSettings({ settingsFile: file, managed: ENV, overrides: { "yuhi.nativeSession": { sessionId: "new" } } });
    expect(next["yuhi.nativeSession"]).toEqual({ sessionId: "new" });
  });

  it("clears only Yuhi's entries on shutdown", async () => {
    const dir = await scratch();
    const file = join(dir, "settings.json");
    await applyManagedSettings({ settingsFile: file, managed: ENV });
    await writeFile(
      file,
      JSON.stringify({
        [CLAUDE_ENV_SETTING_KEY]: [{ name: "USER_KEY", value: "keep" }, { name: "ANTHROPIC_BASE_URL", value: "http://x" }],
      }),
      "utf8",
    );
    await clearManagedSettings(file);
    const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(after[CLAUDE_ENV_SETTING_KEY]).toEqual([{ name: "USER_KEY", value: "keep" }]);
  });
});

describe("official extension contract", () => {
  it("accepts the tested build", () => {
    const r = validateExtensionContract(officialManifest());
    expect(r.ok).toBe(true);
    expect(r.isTestedVersion).toBe(true);
    expect(r.openCommand).toBe("claude-vscode.sidebar.open");
  });

  it("accepts a NEWER version that still honours the contract", () => {
    const r = validateExtensionContract(officialManifest("9.9.9"));
    expect(r.ok).toBe(true);
    expect(r.isTestedVersion).toBe(false);
  });

  it("rejects a changed setting shape rather than silently losing the endpoint", () => {
    const m = officialManifest();
    (m["contributes"] as any).configuration.properties["claudeCode.environmentVariables"] = { type: "object" };
    expect(validateExtensionContract(m).failures).toContain("environment-setting-wrong-shape");
  });

  it("rejects a non-Anthropic publisher and a missing open command", () => {
    const m = officialManifest();
    m["publisher"] = "someone-else";
    (m["contributes"] as any).commands = [];
    const r = validateExtensionContract(m);
    expect(r.failures).toEqual(expect.arrayContaining(["wrong-publisher", "missing-open-command"]));
  });

  it("reports not-installed for a missing manifest", () => {
    expect(validateExtensionContract(undefined).failures).toEqual(["not-installed"]);
  });
});

describe("lock ownership", () => {
  const base: SessionLock = {
    schemaVersion: 1,
    sessionId: "s1",
    workspaceHash: "w1",
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    state: "active",
  };
  const env = { now: () => Date.now(), isProcessAlive: (pid: number) => pid === process.pid };

  it("holds while the pid is alive and the heartbeat is fresh", () => {
    expect(evaluateLock(base, env).kind).toBe("held");
  });

  it("is stale when the heartbeat expired even though the pid lives", () => {
    const old = { ...base, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
    const v = evaluateLock(old, env);
    expect(v.kind).toBe("stale");
    expect(v.kind === "stale" && v.why).toBe("heartbeat-expired");
  });

  it("does not treat a recycled pid as ownership without a fresh heartbeat", () => {
    const foreign = { ...base, ownerPid: 999_999, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
    expect(evaluateLock(foreign, env).kind).toBe("stale");
  });
});

describe("lifecycle", () => {
  it("permits the real path and refuses a jump straight to active", () => {
    expect(canTransition("gateway-ready", "profile-provisioning")).toBe(true);
    expect(canTransition("created", "active")).toBe(false);
  });

  it("records an illegal transition as failed instead of dropping the event", async () => {
    const dir = await scratch();
    const rec = new LifecycleRecorder({
      sessionId: "s",
      lifecycleLog: join(dir, "l.jsonl"),
      sessionRecord: join(dir, "s.json"),
      workspaceHash: "w",
      sourceWorkspaceId: "src",
      deliveryMode: "developer",
      retrievalMode: "disabled",
    });
    await rec.transition("active");
    expect(rec.state()).toBe("failed");
    expect(await readFile(join(dir, "l.jsonl"), "utf8")).toContain("illegal-transition");
  });
});

describe("cleanup", () => {
  it("still closes the gateway when an earlier step throws", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s1", dir);
    await createSessionTree(layout);
    let gatewayClosed = false;
    const result = await cleanupSession(layout, {
      flushEvidence: () => {
        throw new Error("disk full");
      },
      closeGateway: () => {
        gatewayClosed = true;
      },
    });
    expect(gatewayClosed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === "close-gateway")?.ok).toBe(true);
  });

  it("is idempotent and revokes the bootstrap token", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s2", dir);
    await createSessionTree(layout);
    await writeBootstrapToken(layout, newBootstrapToken());
    await cleanupSession(layout, {});
    const second = await cleanupSession(layout, {});
    expect(second.ok).toBe(true);
    await expect(readFile(layout.bootstrapTokenFile, "utf8")).rejects.toThrow();
  });
});

describe("attach authorisation", () => {
  const expectation = {
    sessionId: "s1",
    bootstrapToken: "correct-horse-battery-staple",
    preparedWorkspaceHash: "wshash",
  };
  const good = {
    sessionId: "s1",
    bootstrapToken: expectation.bootstrapToken,
    preparedWorkspaceHash: "wshash",
    clientInstanceId: "c1",
  };

  it("accepts a correct payload once", () => {
    expect(validateAttach(good, expectation, false).ok).toBe(true);
    expect(validateAttach(good, expectation, true).rejection).toBe("already-attached");
  });

  it("refuses a valid session id with a wrong token", () => {
    expect(validateAttach({ ...good, bootstrapToken: "wrong" }, expectation, false).rejection).toBe("bad-token");
  });

  it("refuses a different workspace", () => {
    expect(validateAttach({ ...good, preparedWorkspaceHash: "other" }, expectation, false).rejection).toBe("workspace-mismatch");
  });

  it("rejects unauthenticated control calls over the wire", async () => {
    const server = await startAttachServer(expectation, {
      onAttach: () => {},
      onHeartbeat: () => {},
      onDetach: () => {},
      onStop: async () => {},
    });
    const res = await fetch(`${server.url}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrapToken: "nope" }),
    });
    expect(res.status).toBe(403);
    await server.close();
  });
});

describe("recovery", () => {
  it("finds a dead session, leaves a live one alone, and finishes the shutdown", async () => {
    const root = await scratch();
    const dead = sessionLayout("dead", root);
    const live = sessionLayout("live", root);
    await createSessionTree(dead);
    await createSessionTree(live);
    const now = new Date().toISOString();
    await writeFile(dead.sessionRecord, JSON.stringify({
      schemaVersion: 1, sessionId: "dead", state: "active", clientSurface: "native-gui",
      workspaceHash: "w", sourceWorkspaceId: "w", createdAt: now, updatedAt: now,
      deliveryMode: "developer", retrievalMode: "disabled",
    }), "utf8");
    await writeLock(dead.lockFile, {
      schemaVersion: 1, sessionId: "dead", workspaceHash: "w", ownerPid: 999_999,
      createdAt: now, heartbeatAt: new Date(Date.now() - 120_000).toISOString(), state: "active",
    });
    await writeLock(live.lockFile, {
      schemaVersion: 1, sessionId: "live", workspaceHash: "w2", ownerPid: process.pid,
      createdAt: now, heartbeatAt: now, state: "active",
    });
    const env = { now: () => Date.now(), isProcessAlive: (pid: number) => pid === process.pid, root };

    const found = await discoverSessions(env);
    expect(found.find((s) => s.sessionId === "dead")?.health).toBe("stale");
    expect(found.find((s) => s.sessionId === "live")?.health).toBe("live");

    const swept = await recoverStaleSessions({ env });
    expect(swept.recovered).toContain("dead");
    expect(swept.skippedLive).toContain("live");

    // A second sweep must not "recover" the same corpse again — the public record has to
    // become terminal, or the session list reports a dead session as merely stale forever.
    const again = await recoverStaleSessions({ env });
    expect(again.recovered).not.toContain("dead");
    expect((await discoverSessions(env)).find((s) => s.sessionId === "dead")?.health).toBe("finished");
  });
});

describe("security boundary", () => {
  const CANARY = "sk-ant-api03-CANARYVALUE0000000000";

  it("keeps credentials and paths out of exported diagnostics", () => {
    const exported = exportDiagnostics(
      [
        {
          sessionId: "ngui_1", state: "active", gatewayHealthy: true, vscodeAttached: true,
          claudeExtensionVersion: "2.1.221", deliveryMode: "developer", retrievalMode: "disabled",
          lastHeartbeatAt: new Date().toISOString(), requests: 3, toolResultBlocksObserved: 2,
          toolResultBlocksCompressed: 1, dynamicReduction: 0.5, upstreamErrors: 0,
          retrievalsDelivered: 1, retrievalsWithheld: 0,
          cleanupStatus: "not-started", notes: [],
        },
      ],
      "2026-08-04T00:00:00.000Z",
    );
    const text = JSON.stringify(exported);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/\/Users\//);
  });

  it("strips token-shaped values and absolute paths from any record", () => {
    const out = redactForExport({
      bootstrapToken: "should-not-survive",
      apiKey: CANARY,
      workspacePath: "/Users/someone/secret-project",
      sessionId: "ngui_ok",
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("should-not-survive");
    expect(text).not.toContain("secret-project");
    expect(out["sessionId"]).toBe("ngui_ok");
  });

  it("writes no raw workspace path into the public session record", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s3", dir);
    await createSessionTree(layout);
    const rec = new LifecycleRecorder({
      sessionId: "s3",
      lifecycleLog: layout.lifecycleLog,
      sessionRecord: layout.sessionRecord,
      workspaceHash: workspaceHash("/Users/someone/secret-project"),
      sourceWorkspaceId: workspaceHash("/Users/someone/secret-project"),
      deliveryMode: "strict",
      retrievalMode: "disabled",
    });
    await rec.persist();
    const text = await readFile(layout.sessionRecord, "utf8");
    expect(text).not.toContain("secret-project");
    expect(text).not.toContain("/Users/");
  });

  it("stores the bootstrap token owner-readable only", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s4", dir);
    await createSessionTree(layout);
    await writeBootstrapToken(layout, newBootstrapToken());
    const { stat } = await import("node:fs/promises");
    expect((await stat(layout.bootstrapTokenFile)).mode & 0o077).toBe(0);
  });
});

describe("launch arguments and platform gating", () => {
  it("isolates by user-data-dir AND extensions-dir, disables restricted mode, and does not pass --profile", () => {
    const args = buildLaunchArgs({
      executable: "code", preparedWorkspace: "/prepared",
      userDataDir: "/u", extensionsDir: "/e", profileName: "Yuhi Dynamic",
    });
    expect(args).toEqual([
      "--new-window", "--user-data-dir", "/u", "--extensions-dir", "/e", "--disable-workspace-trust", "/prepared",
    ]);
    expect(args).not.toContain("--profile");
  });

  it("detects remote environments so Native GUI Mode can fail closed", () => {
    expect(detectRemote({ SSH_CONNECTION: "x" })).toBe("ssh");
    expect(detectRemote({ WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl");
    expect(detectRemote({ CODESPACES: "true" })).toBe("codespaces");
    expect(detectRemote({})).toBeUndefined();
  });

  it("prefers a configured executable and refuses a configured-but-missing one", async () => {
    const env = { platform: "darwin" as const, env: {}, home: "/home", which: async () => "/usr/local/bin/code", exists: async (p: string) => p === "/opt/code" };
    expect((await resolveVsCode(env, "/opt/code"))?.source).toBe("configured");
    expect(await resolveVsCode(env, "/missing")).toBeUndefined();
    expect((await resolveVsCode(env))?.source).toBe("path");
  });
});

describe("shutdown leaves nothing behind", () => {
  it("clears the SAME settings file the launcher writes", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s6", dir);
    await createSessionTree(layout);
    // Regression: these two paths once diverged, so close() cleared a file nobody wrote and
    // a dead ANTHROPIC_BASE_URL survived in the isolated settings.
    expect(layout.profileSettings).toBe(join(layout.userDataDir, "User", "settings.json"));

    await applyManagedSettings({ settingsFile: layout.profileSettings, managed: ENV });
    await cleanupSession(layout, {});
    const after = JSON.parse(await readFile(layout.profileSettings, "utf8")) as Record<string, unknown>;
    expect(after[CLAUDE_ENV_SETTING_KEY]).toBeUndefined();
  });
});

describe("session tree", () => {
  it("creates private state owner-only", async () => {
    const dir = await scratch();
    const layout = sessionLayout("s5", dir);
    await createSessionTree(layout);
    const { stat } = await import("node:fs/promises");
    expect((await stat(layout.privateDir)).mode & 0o077).toBe(0);
    await mkdir(join(layout.root, "probe"), { recursive: true });
  });
});

describe("retrieval registration", () => {
  it("registers nothing when retrieval is disabled — the measured default", async () => {
    const dir = await scratch();
    const { registerRetrievalTools } = await import("./mcp-registration.js");
    const path = await registerRetrievalTools("disabled", {
      preparedWorkspace: dir, contextRoot: "/ctx", sessionId: "s", serverScript: "/x/native-mcp.js",
    });
    expect(path).toBeUndefined();
  });

  it("merges into a repository's own .mcp.json instead of replacing it", async () => {
    const dir = await scratch();
    const { registerRetrievalTools, unregisterRetrievalTools, PROJECT_MCP_FILENAME } = await import("./mcp-registration.js");
    const file = join(dir, PROJECT_MCP_FILENAME);
    await writeFile(file, JSON.stringify({ mcpServers: { theirs: { command: "their-server" } } }), "utf8");

    await registerRetrievalTools("required", {
      preparedWorkspace: dir, contextRoot: "/ctx", sessionId: "s", serverScript: "/x/native-mcp.js",
    });
    const withYuhi = JSON.parse(await readFile(file, "utf8")) as any;
    expect(Object.keys(withYuhi.mcpServers).sort()).toEqual(["theirs", "yuhi"]);
    expect(withYuhi.mcpServers.yuhi.args).toEqual(["/x/native-mcp.js"]);
    expect(withYuhi.mcpServers.yuhi.env.YUHI_SESSION_ID).toBe("s");

    // Shutdown must leave the developer's own servers exactly as they were.
    await unregisterRetrievalTools(dir);
    const after = JSON.parse(await readFile(file, "utf8")) as any;
    expect(Object.keys(after.mcpServers)).toEqual(["theirs"]);
  });

  it("removes a .mcp.json it created outright", async () => {
    const dir = await scratch();
    const { registerRetrievalTools, unregisterRetrievalTools, PROJECT_MCP_FILENAME } = await import("./mcp-registration.js");
    await registerRetrievalTools("conditional", {
      preparedWorkspace: dir, contextRoot: "/ctx", sessionId: "s", serverScript: "/x/native-mcp.js",
    });
    await unregisterRetrievalTools(dir);
    await expect(readFile(join(dir, PROJECT_MCP_FILENAME), "utf8")).rejects.toThrow();
  });
});

describe("the isolated window needs a Yuhi that knows about Native GUI Mode", () => {
  it("accepts 0.4.1 and newer, rejects older and unknown", async () => {
    const { yuhiVersionSupportsNativeGui } = await import("./vscode-launcher.js");
    expect(yuhiVersionSupportsNativeGui("0.4.1")).toBe(true);
    expect(yuhiVersionSupportsNativeGui("0.5.0")).toBe(true);
    expect(yuhiVersionSupportsNativeGui("1.0.0")).toBe(true);
    // 0.4.0 has no attach client: the session would sit at `vscode-attaching` forever.
    expect(yuhiVersionSupportsNativeGui("0.4.0")).toBe(false);
    expect(yuhiVersionSupportsNativeGui("0.3.9")).toBe(false);
    expect(yuhiVersionSupportsNativeGui(undefined)).toBe(false);
  });
});
