import { describe, it, expect } from "vitest";
import { AgentRegistry, createFakeAgentAdapter } from "@yuhi/agents";
import type { AgentCommand } from "@yuhi/shared";
import type { CorePreparedSession } from "@yuhi/core";
import {
  performLaunch,
  resolveRunForLaunch,
  buildLaunchSummary,
  formatLaunchSummary,
  type ResolvedRun,
  type RunResolution,
} from "./launch.js";

const CTX = "sha256:" + "a".repeat(64);

function makeRun(workspace = "/managed/prepared/run-xyz"): ResolvedRun {
  const session = {
    schemaVersion: 1,
    preparedBy: "Yuhi",
    runId: "run-xyz",
    contextId: CTX,
    status: "Success",
    launchAllowed: true,
    summary: {
      filesIncluded: 312,
      unresolvedHighRiskFindings: 0,
      preparationReport: { estimatedReductionPercent: 82.6 },
      contextId: CTX,
      runId: "run-xyz",
    },
  } as unknown as CorePreparedSession;
  return { workspace, session };
}

function registryWith(id: string, available = true): AgentRegistry {
  const registry = new AgentRegistry();
  const displayName = id === "claude" ? "Claude Code" : "OpenAI Codex CLI";
  registry.register(id, () => createFakeAgentAdapter({ id, displayName, available }));
  return registry;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    opts: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      captureBaseline: async () => `sha256:${"c".repeat(64)}`,
    },
  };
}

describe("buildLaunchSummary / formatLaunchSummary", () => {
  it("pulls the personal-first numbers and formats the Ready block", () => {
    const s = buildLaunchSummary(makeRun("/prepared/abc"), "Claude Code");
    expect(s).toMatchObject({
      agentDisplayName: "Claude Code",
      contextId: CTX,
      filesVisible: 312,
      contextReductionPercent: 82.6,
      secretsExposed: 0,
      workspacePath: "/prepared/abc",
    });
    const text = formatLaunchSummary(s);
    expect(text).toContain("Ready for Claude Code");
    expect(text).toContain(`Context ID: ${CTX}`);
    expect(text).toContain("Files visible: 312");
    expect(text).toContain("Context reduction: 82.6%");
    expect(text).toContain("Secrets exposed: 0");
    expect(text).toContain("Launching Claude Code in: /prepared/abc");
  });
});

describe("resolveRunForLaunch", () => {
  it("validates and resolves an explicit --run reference", async () => {
    const res = await resolveRunForLaunch("run-xyz", {
      validate: async () => ({ kind: "valid", workspace: "/prepared/xyz", session: makeRun().session }),
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a stale/blocked --run reference with the safe category", async () => {
    const res = await resolveRunForLaunch("run-stale", {
      validate: async () => ({ kind: "recovery-required", category: "blocked" }),
    });
    expect(res).toEqual({ ok: false, category: "blocked" });
  });

  it("rejects a nonexistent --run reference (validate throws)", async () => {
    const res = await resolveRunForLaunch("../escape", {
      validate: async () => {
        throw new Error("outside managed storage");
      },
    });
    expect(res).toEqual({ ok: false, category: "invalid-or-missing-run" });
  });

  it("falls back to the latest completed run when no reference is given", async () => {
    const res = await resolveRunForLaunch(undefined, { latest: async () => makeRun("/prepared/latest") });
    expect(res.ok && res.run.workspace).toBe("/prepared/latest");
  });

  it("reports no-completed-run when there is no latest run", async () => {
    const res = await resolveRunForLaunch(undefined, { latest: async () => null });
    expect(res).toEqual({ ok: false, category: "no-completed-run" });
  });
});

describe("performLaunch — happy path (fake runner, no real CLI)", () => {
  it("launch claude prints the Ready summary and launches via the injected runner", async () => {
    const { out, opts } = capture();
    let captured: AgentCommand | undefined;
    const code = await performLaunch({
      agentId: "claude",
      registry: registryWith("claude"),
      resolveRun: async () => ({ ok: true, run: makeRun("/prepared/happy") }),
      runner: async (cmd) => ((captured = cmd), { exitCode: 0, signal: null }),
      sessionId: "sess-1",
      startedAt: "1970-01-01T00:00:00.000Z",
      ...opts,
    });
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("Ready for Claude Code");
    expect(text).toContain("Files visible: 312");
    expect(text).toContain("Context reduction: 82.6%");
    expect(text).toContain("Secrets exposed: 0");
    expect(text).toContain("Launching Claude Code in: /prepared/happy");
    expect(captured?.cwd).toBe("/prepared/happy");
  });

  it("launch codex works the same way", async () => {
    const { out, opts } = capture();
    const code = await performLaunch({
      agentId: "codex",
      registry: registryWith("codex"),
      resolveRun: async () => ({ ok: true, run: makeRun("/prepared/codex") }),
      runner: async () => ({ exitCode: 0, signal: null }),
      ...opts,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Ready for OpenAI Codex CLI");
  });

  it("emits the public session manifest (no abspath/env) under --json", async () => {
    const { out, opts } = capture();
    await performLaunch({
      agentId: "claude",
      json: true,
      registry: registryWith("claude"),
      resolveRun: async () => ({ ok: true, run: makeRun("/prepared/secret-path") }),
      runner: async () => ({ exitCode: 0, signal: null }),
      ...opts,
    });
    const payload = JSON.parse(out.join("\n"));
    expect(payload.session.contextId).toBe(CTX);
    expect(payload.session.revisionId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload.session.snapshotId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload.session).not.toHaveProperty("workingDirectory");
    expect(JSON.stringify(payload.session)).not.toContain("/prepared/secret-path");
  });
});

describe("performLaunch — failure paths (finite, clear)", () => {
  it("rejects a stale/nonexistent run id with exit 3", async () => {
    const { err, opts } = capture();
    const code = await performLaunch({
      agentId: "claude",
      registry: registryWith("claude"),
      resolveRun: async (): Promise<RunResolution> => ({ ok: false, category: "blocked" }),
      ...opts,
    });
    expect(code).toBe(3);
    expect(err.join("\n")).toContain("invalid-or-missing-run");
  });

  it("exits 4 with install guidance (in finite time) when the agent is not installed", async () => {
    const { err, opts } = capture();
    let ran = false;
    const code = await performLaunch({
      agentId: "claude",
      registry: registryWith("claude", false), // detect() → unavailable
      resolveRun: async () => ({ ok: true, run: makeRun() }),
      runner: async () => ((ran = true), { exitCode: 0, signal: null }),
      ...opts,
    });
    expect(code).toBe(4);
    expect(ran).toBe(false);
    expect(err.join("\n")).toContain("Install Claude Code");
  });

  it("rejects an unknown / non-allowlisted agent id with exit 3", async () => {
    const { err, opts } = capture();
    const code = await performLaunch({
      agentId: "ghost",
      registry: registryWith("claude"), // only claude registered
      resolveRun: async () => ({ ok: true, run: makeRun() }),
      ...opts,
    });
    expect(code).toBe(3);
    expect(err.join("\n")).toContain("unknown-agent");
  });

  it("a dry-run prepares and summarizes but does not spawn", async () => {
    const { out, opts } = capture();
    let ran = false;
    const code = await performLaunch({
      agentId: "claude",
      spawn: false,
      registry: registryWith("claude"),
      resolveRun: async () => ({ ok: true, run: makeRun("/prepared/dry") }),
      runner: async () => ((ran = true), { exitCode: 0, signal: null }),
      ...opts,
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(out.join("\n")).toContain("Ready for Claude Code");
  });

  it("fails closed without spawning when the private patch snapshot cannot be created", async () => {
    const { err, opts } = capture();
    let ran = false;
    const code = await performLaunch({
      agentId: "claude",
      registry: registryWith("claude"),
      resolveRun: async () => ({ ok: true, run: makeRun("/prepared/no-snapshot") }),
      runner: async () => ((ran = true), { exitCode: 0, signal: null }),
      ...opts,
      captureBaseline: async () => { throw new Error("synthetic failure"); },
    });
    expect(code).toBe(3);
    expect(ran).toBe(false);
    expect(err.join("\n")).toContain("patch-snapshot-unavailable");
    expect(err.join("\n")).not.toContain("synthetic failure");
  });
});
