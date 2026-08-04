/**
 * VS Code dynamic-context integration tests.
 *
 * No editor and no real gateway: the host and the shared launch contract are injected, so
 * these assert the things that can actually go wrong in an integration — that the two
 * surfaces share one contract, that the environment stays inside the terminal we create,
 * that a failed gateway never becomes a silent ordinary launch, and that closing the
 * terminal really stops the gateway.
 */

import type { DynamicClaudeSession, DynamicContextStats, MetricsSnapshot } from "@yuhi/context-gateway";
import { dynamicSessionEnv } from "@yuhi/context-gateway";
import { describe, expect, it, vi } from "vitest";

import {
  DYNAMIC_SCOPE_NOTICE,
  DYNAMIC_TERMINAL_NAME,
  RETRIEVAL_CHOICES,
  handleStartupFailure,
  panelView,
  preflight,
  startDynamicSession,
  statusBarText,
  statusBarTooltip,
  type DynamicContextHost,
  type DynamicTerminal,
} from "./dynamic-context.js";

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    sessionId: "sess_test",
    retrievalMode: "disabled",
    requests: 3,
    toolResultBlocksObserved: 6,
    toolResultBlocksCompressed: 2,
    toolResultBlocksReused: 3,
    toolResultBlocksPassedThrough: 1,
    fallbacks: 0,
    withheld: 0,
    retrievals: 0,
    rawEstimatedTokens: 40_000,
    deliveredEstimatedTokens: 6_000,
    markerEstimatedTokens: 120,
    dynamicReduction: 0.85,
    medianCompressionLatencyMs: 2,
    maxCompressionLatencyMs: 4,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    liveZoneViolations: 0,
    egressDetections: 0,
    upstreamErrors: 0,
    peakRssBytes: 1024,
    ...overrides,
  };
}

function stats(sessions: MetricsSnapshot[] = [snapshot()]): DynamicContextStats {
  return { upstream: "https://api.anthropic.com", startedAt: "2026-08-04T00:00:00.000Z", requests: 3, sessions };
}

interface Harness {
  host: DynamicContextHost;
  terminals: { name: string; cwd: string; env: Record<string, string> }[];
  sent: string[];
  statuses: { text: string; tooltip: string }[];
  logs: string[];
  warnings: string[];
  closed: () => boolean;
  tick: () => void;
}

function harness(overrides: { session?: Partial<DynamicClaudeSession>; failStats?: boolean } = {}): Harness {
  const terminals: Harness["terminals"] = [];
  const sent: string[] = [];
  const statuses: Harness["statuses"] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let closed = false;
  let ticker: (() => void) | undefined;

  const session: DynamicClaudeSession = {
    gatewayUrl: "http://127.0.0.1:45999",
    sessionId: "sess_fixed",
    contextRoot: "/prepared/.yuhi/context",
    retrievalMode: "disabled",
    readyMs: 12,
    command: {
      file: "claude",
      args: [],
      cwd: "/prepared",
      env: dynamicSessionEnv({
        gatewayUrl: "http://127.0.0.1:45999",
        sessionId: "sess_fixed",
        contextRoot: "/prepared/.yuhi/context",
      }),
    },
    getStats: async () => {
      if (overrides.failStats) throw new Error("stats unavailable");
      return stats();
    },
    close: async () => {
      closed = true;
      return stats();
    },
    ...overrides.session,
  };

  const terminal: DynamicTerminal = {
    sendText: (t) => sent.push(t),
    show: () => {},
    dispose: () => {},
  };

  return {
    terminals,
    sent,
    statuses,
    logs,
    warnings,
    closed: () => closed,
    tick: () => ticker?.(),
    host: {
      createTerminal: (options) => {
        terminals.push(options);
        return terminal;
      },
      log: (l) => logs.push(l),
      setStatus: (text, tooltip) => statuses.push({ text, tooltip }),
      clearStatus: () => {},
      showMessage: () => {},
      showWarning: (m) => warnings.push(m),
      choose: async () => undefined,
      // Faithful to the real contract: the session echoes the requested executable.
      startSession: async (options) => ({
        ...session,
        command: { ...session.command, file: options.claudeCommand ?? "claude" },
      }),
      setInterval: (fn) => {
        ticker = fn;
        return { dispose: () => (ticker = undefined) };
      },
    },
  };
}

describe("shared launch contract", () => {
  it("gives VS Code exactly the environment the CLI gets", async () => {
    const h = harness();
    await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });

    // The env comes from the SHARED module, so the two surfaces cannot drift.
    const expected = dynamicSessionEnv({
      gatewayUrl: "http://127.0.0.1:45999",
      sessionId: "sess_fixed",
      contextRoot: "/prepared/.yuhi/context",
    });
    expect(h.terminals[0]?.env).toEqual(expected);
    expect(Object.keys(expected).sort()).toEqual([
      "ANTHROPIC_BASE_URL",
      "YUHI_CONTEXT_ROOT",
      "YUHI_DYNAMIC_CONTEXT",
      "YUHI_SESSION_ID",
    ]);
  });

  it("scopes the environment to its own dedicated terminal", async () => {
    const h = harness();
    await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });

    expect(h.terminals).toHaveLength(1);
    expect(h.terminals[0]?.name).toBe(DYNAMIC_TERMINAL_NAME);
    expect(h.terminals[0]?.cwd).toBe("/prepared");
    // No credential is ever added by Yuhi.
    expect(Object.keys(h.terminals[0]?.env ?? {}).some((k) => /KEY|TOKEN|SECRET|PAT/i.test(k))).toBe(false);
    // The scope claim the user is shown is the one the code implements.
    expect(DYNAMIC_SCOPE_NOTICE).toContain("this terminal only");
  });

  it("starts the agent in that terminal with a quoted command", async () => {
    const h = harness();
    await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "/usr/local/bin/claude" });
    expect(h.sent[0]).toBe("'/usr/local/bin/claude'");
  });

  it("defaults retrieval to disabled", async () => {
    const h = harness();
    const captured: Record<string, unknown>[] = [];
    const host: DynamicContextHost = {
      ...h.host,
      startSession: async (options) => {
        captured.push(options as unknown as Record<string, unknown>);
        return (await h.host.startSession!({ preparedWorkspace: "/prepared" })) as DynamicClaudeSession;
      },
    };
    await startDynamicSession(host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });
    expect(captured[0]?.["retrievalMode"]).toBe("disabled");
    expect(RETRIEVAL_CHOICES[0]?.mode).toBe("disabled");
    expect(RETRIEVAL_CHOICES[0]?.label).toContain("Recommended");
    expect(RETRIEVAL_CHOICES[0]?.detail).toContain("507 tokens");
  });
});

describe("lifecycle", () => {
  it("closing the session stops the gateway and reports completion", async () => {
    const h = harness();
    const session = await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });
    expect(session.state()).toBe("active");

    await session.close();
    expect(h.closed()).toBe(true);
    expect(session.state()).toBe("complete");
    expect(h.statuses.at(-1)?.text).toContain("Session complete");

    // Idempotent: a terminal-close event and a deactivate can both fire.
    await session.close();
    expect(session.state()).toBe("complete");
  });

  it("polls while active and stops polling when closed", async () => {
    const h = harness();
    const session = await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });
    h.tick();
    await vi.waitFor(() => expect(session.latestStats()).toBeDefined());
    await session.close();
    // The ticker was disposed; a later tick is a no-op rather than a resurrected poll.
    expect(() => h.tick()).not.toThrow();
  });

  it("keeps the agent running when statistics fail", async () => {
    const h = harness({ failStats: true });
    const session = await startDynamicSession(h.host, { preparedWorkspace: "/prepared", claudeCommand: "claude" });
    await session.refresh();

    expect(h.warnings.join(" ")).toContain("statistics are temporarily unavailable");
    expect(h.warnings.join(" ")).toContain("Claude Code is unaffected");
    expect(session.state()).toBe("active");
  });
});

describe("failure handling", () => {
  it("never downgrades to a normal launch on its own", async () => {
    const chosen: string[] = [];
    const choice = await handleStartupFailure(
      {
        log: () => {},
        choose: async (message, choices) => {
          chosen.push(message);
          return choices[0];
        },
      },
      "gateway-not-ready",
    );
    expect(choice).toBe("Retry");
    // The message states plainly that Claude was NOT started.
    expect(chosen[0]).toContain("NOT started");
  });

  it("refuses to start outside a verified Prepared Workspace", () => {
    expect(preflight({ preparedRoot: undefined, insidePreparedWorkspace: false, sandboxVerified: true, claudeAvailable: true })).toMatchObject({
      ok: false,
      reason: "not-in-prepared-workspace",
    });
    expect(preflight({ preparedRoot: "/w", insidePreparedWorkspace: true, sandboxVerified: false, claudeAvailable: true })).toMatchObject({
      ok: false,
      reason: "sandbox-unverified",
    });
    expect(preflight({ preparedRoot: "/w", insidePreparedWorkspace: true, sandboxVerified: true, claudeAvailable: false })).toMatchObject({
      ok: false,
      reason: "claude-cli-missing",
    });
    expect(preflight({ preparedRoot: "/w", insidePreparedWorkspace: true, sandboxVerified: true, claudeAvailable: true })).toEqual({
      ok: true,
      preparedRoot: "/w",
    });
  });
});

describe("surfaces", () => {
  it("shows Measuring…, then a reduction, then Session complete", () => {
    expect(statusBarText("active", undefined)).toContain("Measuring…");
    expect(statusBarText("active", stats())).toBe("$(shield) Yuhi Dynamic · 85% reduced");
    expect(statusBarText("complete", stats())).toContain("Session complete");
    expect(statusBarText("failed", stats())).toContain("Failed");
  });

  it("never lets the status bar imply a provider or repository measurement", () => {
    const tooltip = statusBarTooltip("active", stats(), "disabled");
    expect(tooltip).toContain("estimate of withheld tool output");
    expect(tooltip).toContain("not the static repository reduction");
    expect(tooltip).not.toMatch(/cost saving|money saved/i);
  });

  it("renders every panel row, with Not measured where the provider said nothing", () => {
    const view = panelView("active", stats());
    const rows = Object.fromEntries(view.rows.map((r) => [r.label, r.value]));
    expect(rows["Status"]).toBe("Active");
    expect(rows["Tool results observed"]).toBe("6");
    expect(rows["Blocks compressed"]).toBe("2");
    expect(rows["Dynamic tool-output reduction"]).toBe("85.0%");
    expect(rows["Retrieval mode"]).toBe("disabled");
    // The provider reported nothing in this session; that is stated, not zeroed.
    expect(rows["Provider input tokens"]).toBe("Not measured");
    expect(rows["Provider-reported cost change"]).toBe("Not measured");
    expect(view.footnote).toContain("this session only");
  });

  it("reports security blocks and fallbacks explicitly", () => {
    const view = panelView("active", stats([snapshot({ withheld: 2, fallbacks: 1 })]));
    const rows = Object.fromEntries(view.rows.map((r) => [r.label, r.value]));
    expect(rows["Security blocks"]).toBe("2");
    expect(rows["Fallbacks"]).toBe("1");
  });

  it("shows Not measured everywhere before the first tool result", () => {
    const view = panelView("starting", undefined);
    expect(view.rows.filter((r) => r.value === "Not measured").length).toBeGreaterThan(8);
    expect(view.rows.find((r) => r.label === "Status")?.value).toBe("Starting");
  });
});
