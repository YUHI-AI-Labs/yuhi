import { describe, expect, it, vi } from "vitest";
import type { AgentCommand } from "@yuhi/shared";
import type { AgentAdapter, AgentRunOutcome, PreparedAgentContext } from "@yuhi/agents";
import { createFakeAgentAdapter } from "@yuhi/agents";
import {
  buildAgentPickerData,
  detectAgentAvailability,
  detectAgents,
  isValidContextId,
  launchPreparedAgent,
  preparedContextFromManifest,
  preparedContextFromRun,
  readLastAgentId,
  rememberLastAgentId,
  renderAgentPicker,
  runAgentLaunch,
  shortContextId,
  LAST_AGENT_STATE_KEY,
  PICKER_TAGLINE,
  type AgentPickerData,
  type AgentRegistryLike,
  type MementoLike,
} from "./agent-picker.js";

const CTX_ID = "sha256:a7f19288b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8";

const context: PreparedAgentContext = {
  workingDirectory: "/managed/run-1",
  contextId: CTX_ID,
  runId: "run-1",
};

/** A fake registry over a fixed id→adapter map; unknown ids reject like the real one. */
function fakeRegistry(adapters: Record<string, AgentAdapter>): AgentRegistryLike & { getCalls: string[] } {
  const getCalls: string[] = [];
  return {
    getCalls,
    async get(id: string): Promise<AgentAdapter> {
      getCalls.push(id);
      const adapter = adapters[id];
      if (!adapter) throw new Error(`Unknown agent adapter "${id}".`);
      return adapter;
    },
  };
}

/** An in-memory Memento for last-used persistence. */
function fakeMemento(initial: Record<string, unknown> = {}): MementoLike & { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      store[key] = value;
    },
  };
}

const okRunner = async (_c: AgentCommand): Promise<AgentRunOutcome> => ({ exitCode: 0, signal: null });

// ---------------------------------------------------------------------------
// Pure render.
// ---------------------------------------------------------------------------

describe("renderAgentPicker", () => {
  const both = (over: Partial<AgentPickerData> = {}): AgentPickerData => ({
    contextId: CTX_ID,
    agents: [
      { id: "claude", displayName: "Claude Code", available: true, isDefault: true },
      { id: "codex", displayName: "Codex", available: true },
    ],
    ...over,
  });

  it("renders BOTH agents as launch actions with a data-agent hook", () => {
    const out = renderAgentPicker(both());
    expect(out).toContain("Launch with");
    expect(out).toContain("Claude Code");
    expect(out).toContain("Codex");
    expect(out).toContain('data-agent="claude"');
    expect(out).toContain('data-agent="codex"');
    expect(out).toContain('class="agentBtn');
  });

  it("shows the run's Context ID (abbreviated, with the full id in a title)", () => {
    const out = renderAgentPicker(both());
    expect(out).toContain("Context ID");
    expect(out).toContain(shortContextId(CTX_ID));
    expect(out).toContain(`title="${CTX_ID}"`);
    expect(out).toContain(PICKER_TAGLINE);
  });

  it("marks the default (last-used) agent primary and leaves the other secondary", () => {
    const out = renderAgentPicker(both());
    // Claude is default → primary + data-default; codex is neither.
    expect(out).toMatch(/data-agent="claude"[^>]*data-default="true"/);
    expect(out).toMatch(/class="agentBtn primary"[^>]*data-agent="claude"/);
    expect(out).not.toMatch(/data-agent="codex"[^>]*data-default/);
  });

  it("softens a not-installed agent: disabled button + calm inline hint, no path", () => {
    const out = renderAgentPicker(
      both({
        agents: [
          { id: "claude", displayName: "Claude Code", available: true, isDefault: true },
          { id: "codex", displayName: "Codex", available: false, installHint: "Codex CLI was not found. Install Codex and try again." },
        ],
      }),
    );
    expect(out).toMatch(/data-agent="codex"[^>]*disabled/);
    expect(out).toContain("Codex CLI was not found. Install Codex and try again.");
    expect(out).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/); // no absolute-ish path
  });

  it("dirty state blocks launch for BOTH agents and shows Re-prepare required", () => {
    const out = renderAgentPicker(both({ dirty: true }));
    expect(out).toContain("Re-prepare required");
    // Both buttons disabled while dirty.
    expect(out).toMatch(/data-agent="claude"[^>]*disabled/);
    expect(out).toMatch(/data-agent="codex"[^>]*disabled/);
    // No primary while dirty.
    expect(out).not.toContain("agentBtn primary");
  });

  it("shows a Launching… label for the agent mid-launch", () => {
    const out = renderAgentPicker(
      both({
        agents: [
          { id: "claude", displayName: "Claude Code", available: true, launching: true },
          { id: "codex", displayName: "Codex", available: true },
        ],
      }),
    );
    expect(out).toContain("Launching…");
  });

  it("escapes untrusted display names and ids", () => {
    const out = renderAgentPicker({
      contextId: CTX_ID,
      agents: [{ id: "x", displayName: "<img src=x onerror=alert(1)>", available: true }],
    });
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// buildAgentPickerData.
// ---------------------------------------------------------------------------

describe("buildAgentPickerData", () => {
  const avail = [
    { id: "claude", available: true },
    { id: "codex", available: true },
  ];

  it("defaults to the last-used agent when it is available", () => {
    const data = buildAgentPickerData({ contextId: CTX_ID, availabilities: avail, lastAgentId: "codex" });
    expect(data.agents.find((a) => a.id === "codex")?.isDefault).toBe(true);
    expect(data.agents.find((a) => a.id === "claude")?.isDefault).toBeUndefined();
  });

  it("falls back to the first available agent when last-used is not installed", () => {
    const data = buildAgentPickerData({
      contextId: CTX_ID,
      availabilities: [
        { id: "claude", available: true },
        { id: "codex", available: false, installHint: "no codex" },
      ],
      lastAgentId: "codex",
    });
    expect(data.agents.find((a) => a.id === "claude")?.isDefault).toBe(true);
    expect(data.agents.find((a) => a.id === "codex")?.available).toBe(false);
    expect(data.agents.find((a) => a.id === "codex")?.installHint).toBe("no codex");
  });

  it("carries dirty + launching state through", () => {
    const data = buildAgentPickerData({
      contextId: CTX_ID,
      availabilities: avail,
      dirty: true,
      launchingAgentId: "claude",
    });
    expect(data.dirty).toBe(true);
    expect(data.agents.find((a) => a.id === "claude")?.launching).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detection — never hangs.
// ---------------------------------------------------------------------------

describe("detectAgentAvailability / detectAgents", () => {
  it("reports availability from the adapter", async () => {
    const registry = fakeRegistry({
      claude: createFakeAgentAdapter({ id: "claude", displayName: "Claude Code", available: true }),
      codex: createFakeAgentAdapter({ id: "codex", displayName: "Codex", available: false }),
    });
    const results = await detectAgents(registry, ["claude", "codex"]);
    expect(results[0]).toMatchObject({ id: "claude", available: true });
    expect(results[1]).toMatchObject({ id: "codex", available: false });
  });

  it("resolves unavailable (never hangs) when the adapter's detect stalls past the budget", async () => {
    const stalling: AgentAdapter = {
      id: "codex",
      displayName: "Codex",
      adapterVersion: "test",
      detect: () => new Promise(() => {}), // never resolves
      prepare: async () => {
        throw new Error("not reached");
      },
      launch: async () => {
        throw new Error("not reached");
      },
    };
    const registry = fakeRegistry({ codex: stalling });
    const started = Date.now();
    const result = await detectAgentAvailability(registry, "codex", { timeoutMs: 30 });
    expect(result.available).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("resolves unavailable for an unknown / rejecting id instead of throwing", async () => {
    const registry = fakeRegistry({});
    const result = await detectAgentAvailability(registry, "codex", { timeoutMs: 50 });
    expect(result).toMatchObject({ id: "codex", available: false });
    expect(result.installHint).toBeTruthy();
  });

  it("settles on abort via the signal", async () => {
    const stalling: AgentAdapter = {
      id: "claude",
      displayName: "Claude Code",
      adapterVersion: "test",
      detect: () => new Promise(() => {}),
      prepare: async () => ({}) as never,
      launch: async () => ({}) as never,
    };
    const controller = new AbortController();
    const registry = fakeRegistry({ claude: stalling });
    const promise = detectAgentAvailability(registry, "claude", { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared prepared context reused by every agent (no re-prepare).
// ---------------------------------------------------------------------------

describe("launchPreparedAgent + reuse of one prepared context", () => {
  it("builds a context from a prepared run without an absolute path leaking into the id", () => {
    const ctx = preparedContextFromRun({ contextId: CTX_ID, outDir: "/managed/run-1", runId: "run-1" });
    expect(ctx.contextId).toBe(CTX_ID);
    expect(ctx.workingDirectory).toBe("/managed/run-1");
  });

  it("launches through the registry adapter with the prepared working directory + forwarded args", async () => {
    const runs: AgentCommand[] = [];
    const runner = async (c: AgentCommand): Promise<AgentRunOutcome> => {
      runs.push(c);
      return { exitCode: 0, signal: null };
    };
    const registry = fakeRegistry({
      claude: createFakeAgentAdapter({ id: "claude", displayName: "Claude Code", configArgs: ["--config"] }),
    });
    const session = await launchPreparedAgent(registry, "claude", context, {
      runner,
      forwardedArgs: ["--flag"],
    });
    expect(session.contextId).toBe(CTX_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cwd).toBe("/managed/run-1");
    expect(runs[0]!.args).toEqual(["--config", "--flag"]);
  });

  it("reuses the SAME prepared context for both agents — no re-prepare, identical Context ID", async () => {
    const claude = createFakeAgentAdapter({ id: "claude", displayName: "Claude Code" });
    const codex = createFakeAgentAdapter({ id: "codex", displayName: "Codex" });
    const claudePrepare = vi.spyOn(claude, "prepare");
    const codexPrepare = vi.spyOn(codex, "prepare");
    const registry = fakeRegistry({ claude, codex });

    const ctx = preparedContextFromRun({ contextId: CTX_ID, outDir: "/managed/run-1", runId: "run-1" });
    const first = await launchPreparedAgent(registry, "claude", ctx, { runner: okRunner });
    const second = await launchPreparedAgent(registry, "codex", ctx, { runner: okRunner });

    expect(first.contextId).toBe(second.contextId);
    // Each adapter's prepare (plan assembly) received the SAME shared context object.
    expect(claudePrepare).toHaveBeenCalledTimes(1);
    expect(codexPrepare).toHaveBeenCalledTimes(1);
    expect(claudePrepare.mock.calls[0]![0]).toBe(ctx);
    expect(codexPrepare.mock.calls[0]![0]).toBe(ctx);
  });

  it("rejects a non-allowlisted agent id (registry allowlist)", async () => {
    const registry = fakeRegistry({});
    await expect(
      launchPreparedAgent(registry, "gemini", context, { runner: okRunner }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Yuhi-Mode window: picker reconstructed from the on-disk manifest.
// ---------------------------------------------------------------------------

describe("preparedContextFromManifest (opened Prepared Workspace / Yuhi-Mode)", () => {
  const PREPARED_ROOT = "/managed/workspaces/run-42";

  it("(1) builds a picker context from the on-disk manifest Context ID", () => {
    const ctx = preparedContextFromManifest({ contextId: CTX_ID, runId: "run-42" }, PREPARED_ROOT);
    expect(ctx).toBeDefined();
    expect(ctx!.contextId).toBe(CTX_ID);
  });

  it("(3) uses the prepared workspace root as the working directory (this window)", () => {
    const ctx = preparedContextFromManifest({ contextId: CTX_ID, runId: "run-42" }, PREPARED_ROOT);
    expect(ctx!.workingDirectory).toBe(PREPARED_ROOT);
  });

  it("(2)+(4) Claude & Codex receive the SAME contextId with NO re-prepare (plan assembly only)", async () => {
    const claude = createFakeAgentAdapter({ id: "claude", displayName: "Claude Code" });
    const codex = createFakeAgentAdapter({ id: "codex", displayName: "Codex" });
    const claudePrepare = vi.spyOn(claude, "prepare");
    const codexPrepare = vi.spyOn(codex, "prepare");
    const registry = fakeRegistry({ claude, codex });

    const ctx = preparedContextFromManifest({ contextId: CTX_ID, runId: "run-42" }, PREPARED_ROOT)!;
    const first = await launchPreparedAgent(registry, "claude", ctx, { runner: okRunner });
    const second = await launchPreparedAgent(registry, "codex", ctx, { runner: okRunner });

    expect(first.contextId).toBe(CTX_ID);
    expect(second.contextId).toBe(CTX_ID);
    // "prepare" here is adapter plan-assembly, NOT the Yuhi-core prepare pipeline — and
    // each adapter saw the SAME reconstructed context object (one prepared run reused).
    expect(claudePrepare).toHaveBeenCalledTimes(1);
    expect(codexPrepare).toHaveBeenCalledTimes(1);
    expect(claudePrepare.mock.calls[0]![0]).toBe(ctx);
    expect(codexPrepare.mock.calls[0]![0]).toBe(ctx);
    // The working directory launched is this window's prepared workspace root.
    expect(first.workingDirectory).toBe(PREPARED_ROOT);
    expect(second.workingDirectory).toBe(PREPARED_ROOT);
  });

  it("(5) a legacy run with NO contextId yields no picker context (fall back to single button)", () => {
    expect(preparedContextFromManifest({ runId: "old" }, PREPARED_ROOT)).toBeUndefined();
    expect(preparedContextFromManifest({ contextId: undefined, runId: "old" }, PREPARED_ROOT)).toBeUndefined();
  });

  it("(6) an INVALID contextId yields no picker context — never throws", () => {
    expect(preparedContextFromManifest({ contextId: "not-a-hash" }, PREPARED_ROOT)).toBeUndefined();
    expect(preparedContextFromManifest({ contextId: "sha256:zzzz" }, PREPARED_ROOT)).toBeUndefined();
    expect(preparedContextFromManifest({ contextId: 12345 }, PREPARED_ROOT)).toBeUndefined();
    expect(isValidContextId(CTX_ID)).toBe(true);
    expect(isValidContextId("sha256:short")).toBe(false);
  });

  it("(7) an uninstalled agent is disabled in the reconstructed Yuhi-Mode picker", () => {
    const data = buildAgentPickerData({
      contextId: CTX_ID,
      availabilities: [
        { id: "claude", available: true },
        { id: "codex", available: false, installHint: "Codex CLI was not found." },
      ],
    });
    const out = renderAgentPicker(data);
    expect(out).toMatch(/data-agent="codex"[^>]*disabled/);
    expect(out).toContain("Codex CLI was not found.");
  });

  it("(8) the reconstructed picker UI shows only the sha256 Context ID — no absolute path", () => {
    const data = buildAgentPickerData({
      contextId: CTX_ID,
      availabilities: [
        { id: "claude", available: true },
        { id: "codex", available: true },
      ],
      lastAgentId: "claude",
    });
    const out = renderAgentPicker(data);
    // The prepared workspace path must NEVER appear in the panel markup.
    expect(out).not.toContain(PREPARED_ROOT);
    expect(out).not.toMatch(/\/managed\/workspaces/);
    expect(out).toContain(shortContextId(CTX_ID));
  });
});

// ---------------------------------------------------------------------------
// Last-used persistence.
// ---------------------------------------------------------------------------

describe("last-used agent memory", () => {
  it("remembers and reads back an allowlisted agent", async () => {
    const memento = fakeMemento();
    await rememberLastAgentId(memento, "codex");
    expect(memento.store[LAST_AGENT_STATE_KEY]).toBe("codex");
    expect(readLastAgentId(memento)).toBe("codex");
  });

  it("ignores a non-allowlisted stored value", () => {
    expect(readLastAgentId(fakeMemento({ [LAST_AGENT_STATE_KEY]: "gemini" }))).toBeUndefined();
    expect(readLastAgentId(fakeMemento())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Orchestrated launch — dirty gate, reliability, one-failure-doesn't-block-other.
// ---------------------------------------------------------------------------

describe("runAgentLaunch", () => {
  it("blocks a dirty run for BOTH agents WITHOUT entering the Launching state", async () => {
    const registry = fakeRegistry({ claude: createFakeAgentAdapter({ id: "claude" }) });
    const launching: (string | null)[] = [];
    for (const id of ["claude", "codex"]) {
      const result = await runAgentLaunch({
        registry,
        id,
        context,
        dirty: true,
        runner: okRunner,
        onLaunchingChange: (v) => launching.push(v),
      });
      expect(result).toEqual({ status: "blocked-dirty" });
    }
    // Never entered "Launching…" for either agent.
    expect(launching).toEqual([]);
  });

  it("refuses an unavailable agent with a calm hint (no launch attempt)", async () => {
    const registry = fakeRegistry({ codex: createFakeAgentAdapter({ id: "codex", available: false }) });
    const result = await runAgentLaunch({
      registry,
      id: "codex",
      context,
      runner: okRunner,
      availability: { id: "codex", available: false, installHint: "Codex CLI was not found." },
    });
    expect(result).toEqual({ status: "unavailable", id: "codex", installHint: "Codex CLI was not found." });
  });

  it("launches, remembers last-used, and clears the launching flag on success", async () => {
    const memento = fakeMemento();
    const registry = fakeRegistry({ claude: createFakeAgentAdapter({ id: "claude", displayName: "Claude Code" }) });
    const launching: (string | null)[] = [];
    const result = await runAgentLaunch({
      registry,
      id: "claude",
      context,
      runner: okRunner,
      availability: { id: "claude", available: true },
      onLaunchingChange: (v) => launching.push(v),
      rememberLast: (id) => rememberLastAgentId(memento, id),
    });
    expect(result.status).toBe("launched");
    expect(memento.store[LAST_AGENT_STATE_KEY]).toBe("claude");
    // Entered launching, then ALWAYS cleared.
    expect(launching).toEqual(["claude", null]);
  });

  it("recovers the UI on a failed launch — never stuck in Launching, does not throw", async () => {
    const throwingRunner = async (): Promise<AgentRunOutcome> => {
      throw new Error("spawn boom");
    };
    const registry = fakeRegistry({ claude: createFakeAgentAdapter({ id: "claude" }) });
    const launching: (string | null)[] = [];
    const result = await runAgentLaunch({
      registry,
      id: "claude",
      context,
      runner: throwingRunner,
      onLaunchingChange: (v) => launching.push(v),
    });
    // The fake adapter maps a throwing runner to a "failed" session (does not throw).
    expect(result.status).toBe("failed");
    // Launching flag was set and then cleared — the UI is usable again.
    expect(launching[launching.length - 1]).toBeNull();
  });

  it("a failure for one agent does NOT prevent launching the other", async () => {
    // codex fails (nonzero exit), claude then succeeds against the same context.
    const failRunner = async (): Promise<AgentRunOutcome> => ({ exitCode: 1, signal: null });
    const registry = fakeRegistry({
      claude: createFakeAgentAdapter({ id: "claude" }),
      codex: createFakeAgentAdapter({ id: "codex" }),
    });
    const codex = await runAgentLaunch({ registry, id: "codex", context, runner: failRunner });
    expect(codex.status).toBe("failed");
    const claude = await runAgentLaunch({ registry, id: "claude", context, runner: okRunner });
    expect(claude.status).toBe("launched");
  });
});
