import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentCommand } from "@yuhi/shared";
import { createCliAgentAdapter } from "./cli-agent.js";
import { createDefaultRegistry, CLI_AGENT_SPECS, UnknownAgentError } from "../registry.js";
import { toPublicAgentSessionManifest } from "../session-manifest.js";
import { YUHI_SECTION_BEGIN, YUHI_SECTION_END } from "./instructions.js";
import type { PreparedAgentContext } from "../adapter.js";

const NODE = process.platform === "win32" ? "node.exe" : "node";
const CONTEXT_ID = "sha256:" + "a".repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function preparedDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "yuhi-prepared-"));
  dirs.push(d);
  return d;
}
function context(workingDirectory: string): PreparedAgentContext {
  return { workingDirectory, contextId: CONTEXT_ID, runId: "run-1" };
}

describe("default registry — claude & codex adapters", () => {
  it("resolves claude and codex with the right ids and display names", async () => {
    const registry = createDefaultRegistry();
    const claude = await registry.get("claude");
    const codex = await registry.get("codex");
    expect(claude.id).toBe("claude");
    expect(claude.displayName).toBe(CLI_AGENT_SPECS.claude.displayName);
    expect(codex.id).toBe("codex");
    expect(codex.displayName).toBe(CLI_AGENT_SPECS.codex.displayName);
  });

  it("rejects an unknown agent id (never executed)", async () => {
    const registry = createDefaultRegistry();
    await expect(registry.get("gemini")).rejects.toBeInstanceOf(UnknownAgentError);
  });
});

describe("cli-agent detect()", () => {
  it("reports available with an executable path for an installed command", async () => {
    const adapter = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const availability = await adapter.detect();
    expect(availability.available).toBe(true);
    expect(availability.executablePath).toBeTruthy();
    expect(availability.installHint).toBeUndefined();
  });

  it("reports unavailable with an install hint for a missing command, within the timeout", async () => {
    const adapter = createCliAgentAdapter({
      id: "codex",
      displayName: "OpenAI Codex CLI",
      command: "definitely-not-installed-xyz",
      installHintUrl: "https://example.invalid/install",
    });
    const start = Date.now();
    const availability = await adapter.detect({ timeoutMs: 2000 });
    expect(availability.available).toBe(false);
    expect(availability.installHint).toContain("https://example.invalid/install");
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("cli-agent prepare() — instruction generation", () => {
  it("writes CLAUDE.md for claude and AGENTS.md for codex into the prepared repo", async () => {
    const root = preparedDir();
    const claude = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const codex = createCliAgentAdapter({ id: "codex", displayName: "OpenAI Codex CLI", command: NODE });

    const planC = await claude.prepare(context(root));
    const planX = await codex.prepare(context(root));

    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(true);
    // Mirrors under .yuhi/agents/<id>/
    expect(existsSync(path.join(root, ".yuhi", "agents", "claude", "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(root, ".yuhi", "agents", "codex", "AGENTS.md"))).toBe(true);

    const claudeMd = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain(CONTEXT_ID);
    expect(claudeMd).toContain(YUHI_SECTION_BEGIN);

    expect(planC.instructionFiles.map((f) => f.relpath)).toContain("CLAUDE.md");
    expect(planX.instructionFiles.map((f) => f.relpath)).toContain("AGENTS.md");
  });

  it("MERGES into an existing instruction file without clobbering user content", async () => {
    const root = preparedDir();
    const userContent = "# My Project Rules\n\nAlways run the tests.\n";
    writeFileSync(path.join(root, "CLAUDE.md"), userContent);

    const claude = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    await claude.prepare(context(root));

    const merged = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(merged).toContain("My Project Rules");
    expect(merged).toContain("Always run the tests.");
    expect(merged).toContain(YUHI_SECTION_BEGIN);
    expect(merged).toContain(YUHI_SECTION_END);
  });

  it("re-preparing updates the Yuhi section in place (no duplicate sections)", async () => {
    const root = preparedDir();
    const claude = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    await claude.prepare(context(root));
    await claude.prepare(context(root));
    const merged = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const occurrences = merged.split(YUHI_SECTION_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not write outside the prepared repo when the dir is missing (warns, never throws)", async () => {
    const claude = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const plan = await claude.prepare(context(path.join(tmpdir(), "yuhi-does-not-exist-xyz")));
    expect(plan.instructionFiles).toHaveLength(0);
    expect(plan.warnings.join(" ")).toMatch(/prepared workspace/i);
  });
});

describe("cli-agent launch() — safe spawn", () => {
  it("launches with cwd = prepared dir and an argv ARRAY (never a shell string)", async () => {
    const root = preparedDir();
    const adapter = createCliAgentAdapter({
      id: "claude",
      displayName: "Claude Code",
      command: NODE,
      configArgs: ["--config"],
    });
    const plan = await adapter.prepare(context(root), { forwardedArgs: ["--flag", "value with space"] });

    let captured: AgentCommand | undefined;
    const session = await adapter.launch(plan, {
      sessionId: "sess-1",
      startedAt: "1970-01-01T00:00:00.000Z",
      runner: async (cmd) => {
        captured = cmd;
        return { exitCode: 0, signal: null };
      },
    });

    expect(captured?.cwd).toBe(root);
    expect(Array.isArray(captured?.args)).toBe(true);
    expect(captured?.args).toEqual(["--config", "--flag", "value with space"]);
    expect(session.status).toBe("exited");
    expect(session.contextId).toBe(CONTEXT_ID);
    expect(session.agent.id).toBe("claude");
  });

  it("passes shell-injection-y args through verbatim as array elements (no shell interpretation)", async () => {
    const root = preparedDir();
    const adapter = createCliAgentAdapter({ id: "codex", displayName: "OpenAI Codex CLI", command: NODE });
    const nasty = ["; rm -rf /", "$(whoami)", "`id`", "&& echo pwned"];
    const plan = await adapter.prepare(context(root), { forwardedArgs: nasty });

    let captured: AgentCommand | undefined;
    await adapter.launch(plan, {
      runner: async (cmd) => {
        captured = cmd;
        return { exitCode: 0, signal: null };
      },
    });
    // Each nasty token is a single, uninterpreted argv element.
    expect(captured?.args).toEqual(nasty);
  });

  it("only passes allow-listed env vars to the child", async () => {
    const root = preparedDir();
    process.env.SECRET_UNRELATED = "should-not-leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const adapter = createCliAgentAdapter({
      id: "claude",
      displayName: "Claude Code",
      command: NODE,
      envPassthrough: ["ANTHROPIC_API_KEY"],
    });
    const plan = await adapter.prepare(context(root));
    let captured: AgentCommand | undefined;
    await adapter.launch(plan, { runner: async (cmd) => ((captured = cmd), { exitCode: 0, signal: null }) });
    expect(captured?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(captured?.env?.SECRET_UNRELATED).toBeUndefined();
    delete process.env.SECRET_UNRELATED;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns a failed session (never spawns) when the working directory is missing", async () => {
    const adapter = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const plan = {
      adapterId: "claude",
      contextId: CONTEXT_ID,
      workingDirectory: path.join(tmpdir(), "yuhi-missing-cwd-xyz"),
      executable: NODE,
      args: [],
      instructionFiles: [],
      envPassthrough: [],
      warnings: [],
    };
    let ran = false;
    const session = await adapter.launch(plan, {
      runner: async () => ((ran = true), { exitCode: 0, signal: null }),
    });
    expect(ran).toBe(false);
    expect(session.status).toBe("failed");
  });

  it("supports a dry-run that does not spawn", async () => {
    const root = preparedDir();
    const adapter = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const plan = await adapter.prepare(context(root));
    let ran = false;
    const session = await adapter.launch(plan, {
      spawn: false,
      runner: async () => ((ran = true), { exitCode: 0, signal: null }),
    });
    expect(ran).toBe(false);
    expect(session.status).toBe("prepared");
  });

  it("the public session manifest omits the absolute working directory and env", async () => {
    const root = preparedDir();
    const adapter = createCliAgentAdapter({ id: "claude", displayName: "Claude Code", command: NODE });
    const plan = await adapter.prepare(context(root));
    const session = await adapter.launch(plan, {
      runner: async () => ({ exitCode: 0, signal: null }),
    });
    const publicManifest = toPublicAgentSessionManifest(session);
    const serialized = JSON.stringify(publicManifest);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("workingDirectory");
    expect(publicManifest.contextId).toBe(CONTEXT_ID);
    expect(publicManifest.agent.id).toBe("claude");
  });
});

describe("one prepared run, both adapters — same contextId, no re-prepare", () => {
  it("claude and codex prepare the SAME prepared repo and keep the SAME contextId", async () => {
    const root = preparedDir();
    const ctx = context(root); // ONE prepared context, ONE contextId
    const registry = createDefaultRegistry();
    const claude = await registry.get("claude");
    const codex = await registry.get("codex");

    const planC = await claude.prepare(ctx);
    const planX = await codex.prepare(ctx);

    // Same context id + working directory — only the adapter (and its file) differ.
    expect(planC.contextId).toBe(ctx.contextId);
    expect(planX.contextId).toBe(ctx.contextId);
    expect(planC.workingDirectory).toBe(root);
    expect(planX.workingDirectory).toBe(root);

    // Both agents' instruction files coexist in the one prepared repo.
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(true);

    const sC = await claude.launch(planC, { runner: async () => ({ exitCode: 0, signal: null }) });
    const sX = await codex.launch(planX, { runner: async () => ({ exitCode: 0, signal: null }) });
    expect(sC.contextId).toBe(sX.contextId);
    expect(sC.agent.id).not.toBe(sX.agent.id);
  });
});
