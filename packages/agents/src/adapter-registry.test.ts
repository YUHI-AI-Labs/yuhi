import { describe, it, expect } from "vitest";
import {
  AgentRegistry,
  UnknownAgentError,
  createDefaultRegistry,
  ALLOWLISTED_AGENT_IDS,
} from "./registry.js";
import { createFakeAgentAdapter } from "./testing.js";
import type { PreparedAgentContext } from "./adapter.js";

const CONTEXT: PreparedAgentContext = {
  workingDirectory: "/managed/prepared/run-1",
  contextId: "sha256:" + "a".repeat(64),
  runId: "run-1",
};

describe("AgentRegistry — allowlist & resolution", () => {
  it("returns a registered adapter by id", async () => {
    const registry = new AgentRegistry();
    registry.register("fake", () => createFakeAgentAdapter({ id: "fake" }));
    const adapter = await registry.get("fake");
    expect(adapter.id).toBe("fake");
  });

  it("rejects an unknown adapter id and never executes it", async () => {
    const registry = new AgentRegistry();
    registry.register("fake", () => createFakeAgentAdapter({ id: "fake" }));
    await expect(registry.get("not-allowlisted")).rejects.toBeInstanceOf(UnknownAgentError);
    expect(registry.has("not-allowlisted")).toBe(false);
  });

  it("caches the resolved adapter (factory runs once)", async () => {
    const registry = new AgentRegistry();
    let calls = 0;
    registry.register("fake", () => {
      calls += 1;
      return createFakeAgentAdapter({ id: "fake" });
    });
    const a = await registry.get("fake");
    const b = await registry.get("fake");
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("the default registry allowlists the intended agent ids", () => {
    const registry = createDefaultRegistry();
    for (const id of ALLOWLISTED_AGENT_IDS) expect(registry.has(id)).toBe(true);
    expect(registry.has("totally-unknown")).toBe(false);
  });
});

describe("AgentRegistry — lazy loading (adapter deps not loaded on import)", () => {
  it("does not evaluate an adapter module until get() is called", async () => {
    const g = globalThis as unknown as { __yuhiSideEffectAdapterLoads?: number };
    const before = g.__yuhiSideEffectAdapterLoads ?? 0;

    const registry = new AgentRegistry();
    registry.register("side-effect", async () => {
      const mod = await import("./__fixtures__/side-effect-adapter.js");
      return mod.createSideEffectAdapter();
    });

    // Registering (and importing @yuhi/agents) must NOT have loaded the module.
    expect(g.__yuhiSideEffectAdapterLoads ?? 0).toBe(before);

    await registry.get("side-effect");
    expect(g.__yuhiSideEffectAdapterLoads ?? 0).toBe(before + 1);
  });
});

describe("AgentRegistry — one prepared run, multiple adapters", () => {
  it("lets two different adapters prepare the SAME prepared context", async () => {
    const registry = new AgentRegistry();
    registry.register("agent-a", () => createFakeAgentAdapter({ id: "agent-a" }));
    registry.register("agent-b", () => createFakeAgentAdapter({ id: "agent-b" }));

    const a = await registry.get("agent-a");
    const b = await registry.get("agent-b");

    const planA = await a.prepare(CONTEXT, { forwardedArgs: ["--x"] });
    const planB = await b.prepare(CONTEXT, { forwardedArgs: ["--y"] });

    // Same context id + working directory across agents; only the adapter differs.
    expect(planA.contextId).toBe(CONTEXT.contextId);
    expect(planB.contextId).toBe(CONTEXT.contextId);
    expect(planA.workingDirectory).toBe(CONTEXT.workingDirectory);
    expect(planB.workingDirectory).toBe(CONTEXT.workingDirectory);
    expect(planA.adapterId).toBe("agent-a");
    expect(planB.adapterId).toBe("agent-b");

    // Both launches carry the same Context ID (agent-independent identity).
    const sessionA = await a.launch(planA, { runner: async () => ({ exitCode: 0, signal: null }) });
    const sessionB = await b.launch(planB, { runner: async () => ({ exitCode: 0, signal: null }) });
    expect(sessionA.contextId).toBe(sessionB.contextId);
    expect(sessionA.agent.id).not.toBe(sessionB.agent.id);
  });
});

describe("AgentAdapter — command assembly is an argv array (never a shell string)", () => {
  it("assembles args as [configArgs, forwardedArgs] with cwd = prepared repo", async () => {
    const adapter = createFakeAgentAdapter({ id: "fake", configArgs: ["--config"] });
    const plan = await adapter.prepare(CONTEXT, { forwardedArgs: ["--flag", "value"] });
    expect(Array.isArray(plan.args)).toBe(true);
    expect(plan.args).toEqual(["--config", "--flag", "value"]);
    expect(plan.workingDirectory).toBe(CONTEXT.workingDirectory);
  });

  it("supports a dry-run launch that does not spawn", async () => {
    const adapter = createFakeAgentAdapter({ id: "fake" });
    const plan = await adapter.prepare(CONTEXT);
    let ran = false;
    const session = await adapter.launch(plan, {
      spawn: false,
      runner: async () => {
        ran = true;
        return { exitCode: 0, signal: null };
      },
    });
    expect(ran).toBe(false);
    expect(session.status).toBe("prepared");
  });
});
