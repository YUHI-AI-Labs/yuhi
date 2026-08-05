/**
 * CLI dynamic-context tests (spec §11, §12).
 *
 * The real `claude` binary is never spawned: the runner and the gateway are injected.
 * What IS asserted is the wiring — that the agent gets the loopback endpoint, that
 * provider setups Yuhi cannot proxy are refused instead of broken, and that the launch
 * still goes through `performLaunch` so Safe Apply is untouched.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentCommand } from "@yuhi/shared";
import type { GatewayHandle, GatewayStats, MetricsSnapshot } from "@yuhi/context-gateway";
import { describe, expect, it } from "vitest";

import { credentialPresence, detectUpstream, dynamicContextEnv, mcpConfig } from "./environment.js";
import { writeMcpConfig } from "./gateway-process.js";
import { startDynamicClaudeSession } from "@yuhi/context-gateway";
import { createDynamicRunner, launchClaudeWithDynamicContext } from "./launch-dynamic.js";
import { formatSnapshot, formatStatsReport } from "./stats.js";
import { formatDoctorReport, doctorExitCode, runDynamicDoctor } from "./doctor.js";

const EMPTY_SNAPSHOT: MetricsSnapshot = {
  sessionId: "sess_test",
  requests: 2,
  toolResultBlocksObserved: 3,
  toolResultBlocksCompressed: 2,
  toolResultBlocksReused: 1,
  toolResultBlocksPassedThrough: 0,
  fallbacks: 0,
  withheld: 0,
  retrievals: 1,
  rawEstimatedTokens: 40_000,
  deliveredEstimatedTokens: 6_000,
  markerEstimatedTokens: 120,
  dynamicReduction: 0.85,
  medianCompressionLatencyMs: 42,
  maxCompressionLatencyMs: 90,
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  liveZoneViolations: 0,
  egressDetections: 0,
  upstreamErrors: 0,
  peakRssBytes: 120 * 1024 * 1024,
};

function fakeGateway(url = "http://127.0.0.1:45999"): { handle: GatewayHandle; closed: () => boolean } {
  let closed = false;
  const stats: GatewayStats = { upstream: "https://api.anthropic.com", startedAt: "2026-08-03T00:00:00.000Z", requests: 2, sessions: [EMPTY_SNAPSHOT] };
  return {
    handle: {
      url,
      port: 45999,
      storeRoot: "/tmp/does-not-matter",
      stats: () => stats,
      close: async () => {
        closed = true;
      },
    },
    closed: () => closed,
  };
}

describe("upstream detection", () => {
  it("refuses to insert itself into Bedrock or Vertex setups", () => {
    const bedrock = detectUpstream({ CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(bedrock.supportsDynamicContext).toBe(false);
    expect(bedrock.mode).toBe("bedrock");
    expect(detectUpstream({ CLAUDE_CODE_USE_VERTEX: "1" }).supportsDynamicContext).toBe(false);
  });

  it("chains an existing enterprise gateway instead of replacing it", () => {
    const upstream = detectUpstream({ ANTHROPIC_BASE_URL: "https://llm.corp.example/anthropic" });
    expect(upstream.mode).toBe("enterprise-gateway");
    expect(upstream.baseUrl).toBe("https://llm.corp.example/anthropic");
  });

  it("ignores a loopback base URL so a re-launch does not chain onto itself", () => {
    expect(detectUpstream({ ANTHROPIC_BASE_URL: "http://127.0.0.1:5123" }).mode).toBe("subscription");
  });

  it("detects an API key and a subscription without reading the value", () => {
    expect(detectUpstream({ ANTHROPIC_API_KEY: "sk-ant-secret" }).mode).toBe("anthropic-api");
    const presence = credentialPresence({ ANTHROPIC_API_KEY: "sk-ant-secret" }, "/nonexistent-home");
    expect(presence).toEqual({ apiKeyPresent: true, authTokenPresent: false, storedCredentialsPresent: false });
    expect(JSON.stringify(presence)).not.toContain("sk-ant");
  });
});

describe("child environment and MCP registration", () => {
  it("points the agent at the gateway and tells the MCP server where the store is", () => {
    const env = dynamicContextEnv({
      gatewayUrl: "http://127.0.0.1:45999",
      sessionId: "sess_abc",
      contextRoot: "/w/.yuhi/context",
      mcpConfigPath: "/w/.yuhi/context/mcp/yuhi-mcp.json",
    });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:45999");
    expect(env["YUHI_SESSION_ID"]).toBe("sess_abc");
    // No credential is ever added by Yuhi.
    expect(Object.keys(env).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });

  it("registers exactly one MCP server, scoped to this session's store", async () => {
    const contextRoot = join(await mkdtemp(join(tmpdir(), "yuhi-mcpcfg-")), "context");
    const path = await writeMcpConfig({
      workspace: "/w",
      contextRoot,
      sessionId: "sess_abc",
      cliEntry: "/usr/local/bin/yuhi",
    });
    const written = JSON.parse(await readFile(path, "utf8")) as ReturnType<typeof mcpConfig>;
    expect(Object.keys(written.mcpServers)).toEqual(["yuhi"]);
    expect(written.mcpServers["yuhi"]).toMatchObject({
      args: ["/usr/local/bin/yuhi", "mcp", "serve"],
      env: { YUHI_CONTEXT_ROOT: contextRoot, YUHI_SESSION_ID: "sess_abc" },
    });
  });

  it("merges the dynamic env into the agent command without dropping its own env", async () => {
    const seen: AgentCommand[] = [];
    const runner = createDynamicRunner({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }, async (command) => {
      seen.push(command);
      return { exitCode: 0, signal: null };
    });
    await runner({ file: "claude", args: [], cwd: "/w", env: { PATH: "/usr/bin", HOME: "/h" } } as AgentCommand);
    expect(seen[0]?.env).toMatchObject({ PATH: "/usr/bin", HOME: "/h", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" });
  });
});

describe("launch orchestration", () => {
  it("starts the gateway, launches through performLaunch, then flushes and closes", async () => {
    const fake = fakeGateway();
    const lines: string[] = [];
    let launchOptions: Record<string, unknown> | undefined;

    const result = await launchClaudeWithDynamicContext({
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => "/prepared/workspace",
      startGatewayImpl: async () => fake.handle,
      fetchProbe: async () => ({ ok: true }),
      performLaunchImpl: async (opts) => {
        launchOptions = opts as unknown as Record<string, unknown>;
        return 0;
      },
      sessionId: "sess_fixed",
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });

    expect(result.exitCode).toBe(0);
    // Safe Apply and the prepared-run snapshot stay in performLaunch's hands.
    expect(launchOptions?.["agentId"]).toBe("claude");
    expect(typeof launchOptions?.["runner"]).toBe("function");
    expect(fake.closed()).toBe(true);
    expect(lines.join("\n")).toContain("Yuhi dynamic context: ON");
    expect(lines.join("\n")).toContain("Dynamic tool-output reduction: 85.0%");
  });

  it("defaults to retrieval disabled and never registers MCP in that mode", async () => {
    const lines: string[] = [];
    let gatewayOptions: Record<string, unknown> | undefined;
    await launchClaudeWithDynamicContext({
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => "/prepared/workspace",
      startGatewayImpl: async (o) => {
        gatewayOptions = o as unknown as Record<string, unknown>;
        return fakeGateway().handle;
      },
      fetchProbe: async () => ({ ok: true }),
      performLaunchImpl: async () => 0,
      cliEntry: "/usr/local/bin/yuhi",
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    // Measured: registering the tools cost turns and money on tasks that never needed them.
    expect(gatewayOptions?.["retrievalMode"]).toBe("disabled");
    expect(lines.join("\n")).toContain("Retrieval mode: disabled");
    expect(lines.join("\n")).toContain("not registered");
    // Reversibility is unaffected: the originals are still stored privately.
    expect(lines.join("\n")).toContain("stored privately");
  });

  it("registers MCP and propagates the mode when retrieval is requested", async () => {
    const lines: string[] = [];
    let gatewayOptions: Record<string, unknown> | undefined;
    await launchClaudeWithDynamicContext({
      retrieval: "conditional",
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => join(await mkdtemp(join(tmpdir(), "yuhi-ws-")), "prepared"),
      startGatewayImpl: async (o) => {
        gatewayOptions = o as unknown as Record<string, unknown>;
        return fakeGateway().handle;
      },
      fetchProbe: async () => ({ ok: true }),
      performLaunchImpl: async () => 0,
      cliEntry: "/usr/local/bin/yuhi",
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(gatewayOptions?.["retrievalMode"]).toBe("conditional");
    expect(lines.join("\n")).toContain("Retrieval mode: conditional");
    expect(lines.join("\n")).toContain("Retrieval tools registered (MCP)");
  });

  it("refuses to launch — clearly — when the provider cannot be proxied", async () => {
    const errors: string[] = [];
    const result = await launchClaudeWithDynamicContext({
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      err: (l) => errors.push(l),
      out: () => {},
      performLaunchImpl: async () => {
        throw new Error("must not launch");
      },
    });
    expect(result.exitCode).toBe(3);
    expect(errors.join("\n")).toContain("not available for this provider");
    expect(errors.join("\n")).toContain("without --dynamic-context");
  });

  it("v0.4.8: propagates privacyMode into the gateway and prints the resolved (dynamic-terminal) banner", async () => {
    const lines: string[] = [];
    let gatewayOptions: Record<string, unknown> | undefined;
    await launchClaudeWithDynamicContext({
      privacyMode: "strict",
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => "/prepared/workspace",
      startGatewayImpl: async (o) => {
        gatewayOptions = o as unknown as Record<string, unknown>;
        return fakeGateway().handle;
      },
      fetchProbe: async () => ({ ok: true }),
      performLaunchImpl: async () => 0,
      sessionId: "sess_fixed",
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(gatewayOptions?.["privacyMode"]).toBe("strict");
    // deliveryPolicy composed FROM privacyMode: Strict -> secrets redacted too.
    expect((gatewayOptions?.["deliveryPolicy"] as { mode?: string } | undefined)?.mode).toBe("strict");
    const text = lines.join("\n");
    expect(text).toContain("Privacy: Strict");
    // The dynamic-terminal wording claims BOTH identifiers and secrets are masked
    // under Strict -- different from the static-prepare copy, which never mentions
    // secrets being conditionally delivered at all.
    expect(text).toMatch(/personal identifiers and detected secrets/i);
  });

  it("v0.4.8: legacy --delivery-mode still resolves to the equivalent Privacy Mode banner when privacyMode is not given", async () => {
    const lines: string[] = [];
    let gatewayOptions: Record<string, unknown> | undefined;
    await launchClaudeWithDynamicContext({
      deliveryMode: "developer",
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => "/prepared/workspace",
      startGatewayImpl: async (o) => {
        gatewayOptions = o as unknown as Record<string, unknown>;
        return fakeGateway().handle;
      },
      fetchProbe: async () => ({ ok: true }),
      performLaunchImpl: async () => 0,
      sessionId: "sess_fixed",
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(gatewayOptions?.["privacyMode"]).toBe("balanced");
    expect((gatewayOptions?.["deliveryPolicy"] as { mode?: string } | undefined)?.mode).toBe("developer");
    expect(lines.join("\n")).toContain("Privacy: Balanced");
  });

  it("fails closed when the gateway never becomes ready", async () => {
    const errors: string[] = [];
    const result = await launchClaudeWithDynamicContext({
      upstream: { mode: "anthropic-api", baseUrl: "https://api.anthropic.com", supportsDynamicContext: true },
      resolveWorkspace: async () => "/prepared/workspace",
      startGatewayImpl: async () => fakeGateway().handle,
      fetchProbe: async () => {
        throw new Error("not listening");
      },
      performLaunchImpl: async () => {
        throw new Error("must not launch");
      },
      err: (l) => errors.push(l),
      out: () => {},
    });
    expect(result.exitCode).toBe(3);
    expect(errors.join("\n")).toContain("gateway-not-ready");
  });

  it("times out rather than hanging when readiness never arrives", async () => {
    // The shared launch contract owns this, so the CLI and VS Code time out identically.
    await expect(
      startDynamicClaudeSession({
        preparedWorkspace: "/unused",
        startGatewayImpl: async () => fakeGateway().handle,
        readyProbe: async () => ({ ok: false }),
        startupTimeoutMs: 120,
      }),
    ).rejects.toThrow("gateway-not-ready");
  });
});

describe("stats and doctor reporting", () => {
  it("never presents dynamic reduction as a cost or provider saving", () => {
    const report = formatStatsReport({
      upstream: "https://api.anthropic.com",
      startedAt: "2026-08-03T00:00:00.000Z",
      requests: 2,
      sessions: [EMPTY_SNAPSHOT],
    });
    expect(report).toContain("Dynamic tool-output reduction: 85.0%");
    expect(report).toContain("NOT a provider token measurement");
    // The disclaimer names those words to deny them; what must never appear is a CLAIM.
    expect(report).not.toMatch(/you saved|saved \$|cost reduction:/i);
    // Unmeasured provider usage is reported as unmeasured, not as zero benefit.
    expect(report).toContain("Not measured");
  });

  it("reports marker overhead and live-zone violations explicitly", () => {
    const lines = formatSnapshot(EMPTY_SNAPSHOT).join("\n");
    expect(lines).toContain("marker overhead included: 120 tokens");
    expect(lines).toContain("Live-zone violations (prefix bytes changed outside the live zone): 0");
  });

  it("runs the doctor offline without touching the network or printing secrets", async () => {
    const checks = await runDynamicDoctor({
      offline: true,
      env: { ANTHROPIC_API_KEY: "sk-ant-super-secret" },
      registry: {
        has: () => true,
        get: async () => ({ detect: async () => ({ available: true }) }),
      } as never,
      resolveRun: async () => ({ ok: false, category: "no-completed-run" }) as never,
    });
    const report = formatDoctorReport(checks);
    expect(report).toContain("ANTHROPIC_API_KEY");
    expect(report).toContain("(value not read)");
    expect(report).not.toContain("sk-ant-super-secret");
    expect(checks.find((c) => c.name === "Compression modules")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "Safety scanner")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "Context store writable")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "Upstream connectivity")?.status).toBe("unknown");
    expect(doctorExitCode(checks)).toBe(0);
  });

  it("exits non-zero when a blocking check fails", () => {
    expect(doctorExitCode([{ name: "x", status: "fail", detail: "" }])).toBe(4);
    expect(doctorExitCode([{ name: "x", status: "warn", detail: "" }])).toBe(0);
  });
});
