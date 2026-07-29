import { describe, it, expect } from "vitest";
import { isYuhiError } from "@yuhi/shared";
import { buildChildEnv, missingPassthrough } from "./env.js";
import { lookupOnPath, isInstalled } from "./which.js";
import { buildAdapter, DummyAdapter, GenericAdapter } from "./adapters.js";
import { runCommand } from "./run.js";

describe("child environment (T7)", () => {
  it("does NOT leak arbitrary parent env vars", () => {
    process.env.MY_SUPER_SECRET = "sk-should-not-leak";
    const env = buildChildEnv([]);
    expect(env.MY_SUPER_SECRET).toBeUndefined();
    delete process.env.MY_SUPER_SECRET;
  });

  it("passes PATH and sets the YUHI_ACTIVE marker", () => {
    const env = buildChildEnv([]);
    expect(env.PATH ?? env.Path).toBeDefined();
    expect(env.YUHI_ACTIVE).toBe("1");
  });

  it("passes ONLY allow-listed variables through", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const env = buildChildEnv(["ANTHROPIC_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("reports missing allow-listed vars", () => {
    expect(missingPassthrough(["DEFINITELY_NOT_SET_123"])).toContain("DEFINITELY_NOT_SET_123");
  });
});

describe("which", () => {
  it("finds node on PATH", () => {
    expect(isInstalled(process.platform === "win32" ? "node.exe" : "node")).toBe(true);
  });
  it("returns null for a nonexistent command", () => {
    expect(lookupOnPath("definitely-not-a-real-command-xyz")).toBeNull();
  });
});

describe("adapters", () => {
  it("dummy adapter is always available and forwards args", async () => {
    const a = buildAdapter("dummy");
    expect(a).toBeInstanceOf(DummyAdapter);
    expect(await a.detect()).toBe(true);
    const cmd = await a.buildCommand({
      agentId: "dummy",
      workspacePath: process.cwd(),
      forwardedArgs: ["--flag", "value"],
      env: buildChildEnv([]),
      interactive: false,
    });
    expect(cmd.args).toContain("--flag");
    expect(cmd.cwd).toBe(process.cwd());
  });

  it("runs the dummy agent to completion with exit 0", async () => {
    const a = buildAdapter("dummy");
    const cmd = await a.buildCommand({
      agentId: "dummy",
      workspacePath: process.cwd(),
      forwardedArgs: [],
      env: buildChildEnv([]),
      interactive: false,
    });
    const res = await runCommand(cmd);
    expect(res.exitCode).toBe(0);
  });

  it("named claude adapter resolves with an install hint", () => {
    const a = buildAdapter("claude", { command: "claude", destination: "external" });
    expect(a).toBeInstanceOf(GenericAdapter);
    expect(a.displayName).toBe("Claude Code");
  });

  it("buildCommand throws AGENT_NOT_INSTALLED for a missing CLI", async () => {
    const a = buildAdapter("ghostagent", { command: "definitely-not-installed-xyz" });
    let threw = false;
    try {
      await a.buildCommand({
        agentId: "ghostagent",
        workspacePath: process.cwd(),
        forwardedArgs: [],
        env: {},
        interactive: false,
      });
    } catch (e) {
      threw = true;
      expect(isYuhiError(e) && e.code).toBe("AGENT_NOT_INSTALLED");
    }
    expect(threw).toBe(true);
  });
});
