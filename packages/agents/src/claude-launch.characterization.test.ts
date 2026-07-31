/**
 * CHARACTERIZATION tests (Yuhi v0.3.4, Step 1).
 *
 * These PIN the CURRENT observable behavior of the existing Claude launch path —
 * the legacy `buildAdapter("claude")` / GenericAdapter — WITHOUT changing it, so a
 * later agent can move this behavior behind the new AgentAdapter and prove nothing
 * observable changed. If one of these fails after a refactor, the contract moved.
 */
import { describe, it, expect } from "vitest";
import { isYuhiError } from "@yuhi/shared";
import { buildAdapter, defaultEnvPassthrough } from "./adapters.js";
import { buildChildEnv } from "./env.js";

const NODE = process.platform === "win32" ? "node.exe" : "node";

describe("characterization: existing Claude launch (legacy adapter)", () => {
  it("Claude adapter resolves with the Claude Code display name", () => {
    const adapter = buildAdapter("claude", { command: "claude", destination: "external" });
    expect(adapter.displayName).toBe("Claude Code");
  });

  it("working directory IS the prepared workspace path", async () => {
    const adapter = buildAdapter("claude", { command: NODE });
    const cmd = await adapter.buildCommand({
      agentId: "claude",
      workspacePath: "/managed/prepared/run-1",
      forwardedArgs: [],
      env: buildChildEnv([]),
      interactive: false,
    });
    expect(cmd.cwd).toBe("/managed/prepared/run-1");
  });

  it("args are assembled as [configArgs, ...forwardedArgs] (an array, not a shell string)", async () => {
    const adapter = buildAdapter("claude", { command: NODE, args: ["--config"] });
    const cmd = await adapter.buildCommand({
      agentId: "claude",
      workspacePath: process.cwd(),
      forwardedArgs: ["--flag", "value with space"],
      env: buildChildEnv([]),
      interactive: false,
    });
    expect(Array.isArray(cmd.args)).toBe(true);
    expect(cmd.args).toEqual(["--config", "--flag", "value with space"]);
  });

  it("resolves the executable to an absolute path and passes env through unchanged", async () => {
    const env = buildChildEnv([]);
    const adapter = buildAdapter("claude", { command: NODE });
    const cmd = await adapter.buildCommand({
      agentId: "claude",
      workspacePath: process.cwd(),
      forwardedArgs: [],
      env,
      interactive: false,
    });
    expect(cmd.file).toMatch(/node/);
    expect(cmd.file.includes("/") || cmd.file.includes("\\")).toBe(true);
    expect(cmd.env).toBe(env);
  });

  it("detection reflects PATH: installed command true, missing command false", async () => {
    expect(await buildAdapter("claude", { command: NODE }).detect()).toBe(true);
    expect(
      await buildAdapter("claude", { command: "definitely-not-installed-xyz" }).detect(),
    ).toBe(false);
  });

  it("buildCommand throws AGENT_NOT_INSTALLED when the CLI is missing", async () => {
    const adapter = buildAdapter("claude", { command: "definitely-not-installed-xyz" });
    let caught: unknown;
    try {
      await adapter.buildCommand({
        agentId: "claude",
        workspacePath: process.cwd(),
        forwardedArgs: [],
        env: {},
        interactive: false,
      });
    } catch (e) {
      caught = e;
    }
    expect(isYuhiError(caught) && caught.code).toBe("AGENT_NOT_INSTALLED");
  });

  it("default env passthrough for Claude is the ANTHROPIC allow-list", () => {
    expect(defaultEnvPassthrough("claude")).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ]);
  });
});
