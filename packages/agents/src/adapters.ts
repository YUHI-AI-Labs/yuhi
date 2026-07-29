import {
  YuhiError,
  type AgentAdapter,
  type AgentCommand,
  type AgentRunContext,
  type ValidationResult,
} from "@yuhi/shared";
import { isInstalled, lookupOnPath } from "./which.js";

export interface AgentConfigLike {
  command: string;
  destination?: "external" | "local";
  args?: string[];
  env_passthrough?: string[];
}

/**
 * Adapter for any CLI that is launched with `cwd = workspace` and the forwarded
 * args appended. This is the vendor-neutral core: new agents need no code, just a
 * config entry (see docs). Named agents below add install hints + status.
 */
export class GenericAdapter implements AgentAdapter {
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly command: string,
    private readonly configArgs: string[] = [],
    private readonly hintUrl?: string,
  ) {}

  async detect(): Promise<boolean> {
    return isInstalled(this.command);
  }

  installHint(): string {
    const base = `The "${this.command}" CLI was not found on your PATH.`;
    return this.hintUrl ? `${base} Install it from ${this.hintUrl}.` : base;
  }

  async validate(ctx: AgentRunContext): Promise<ValidationResult> {
    const problems: string[] = [];
    if (!(await this.detect())) problems.push(this.installHint());
    if (!ctx.workspacePath) problems.push("No workspace path was provided.");
    return { ok: problems.length === 0, problems };
  }

  async buildCommand(ctx: AgentRunContext): Promise<AgentCommand> {
    const file = lookupOnPath(this.command);
    if (file === null) {
      throw new YuhiError("AGENT_NOT_INSTALLED", this.installHint(), {
        hint: this.hintUrl ? `See ${this.hintUrl}` : undefined,
      });
    }
    return {
      file,
      args: [...this.configArgs, ...ctx.forwardedArgs],
      cwd: ctx.workspacePath,
      env: ctx.env,
    };
  }
}

/** Inline, dependency-free "agent" that just reports the context it can see. */
const DUMMY_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
let files = 0;
const stack = [root];
while (stack.length) {
  const d = stack.pop();
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) stack.push(p);
    else if (e.isFile()) files++;
  }
}
console.log("[yuhi dummy agent] This is a bundled stand-in for a real AI agent.");
console.log("[yuhi dummy agent] Working directory (the generated context): " + root);
console.log("[yuhi dummy agent] Files visible to the agent: " + files);
const extra = process.argv.slice(2);
if (extra.length) console.log("[yuhi dummy agent] Forwarded args: " + JSON.stringify(extra));
process.exit(0);
`;

/** The bundled dummy agent — always available, offline, used by demos/tests/CI. */
export class DummyAdapter implements AgentAdapter {
  readonly id = "dummy";
  readonly displayName = "Dummy agent (bundled)";

  async detect(): Promise<boolean> {
    return true;
  }
  installHint(): string {
    return "The dummy agent is bundled with Yuhi; no installation needed.";
  }
  async validate(): Promise<ValidationResult> {
    return { ok: true, problems: [] };
  }
  async buildCommand(ctx: AgentRunContext): Promise<AgentCommand> {
    return {
      file: process.execPath,
      args: ["-e", DUMMY_SCRIPT, "--", ...ctx.forwardedArgs],
      cwd: ctx.workspacePath,
      env: ctx.env,
    };
  }
}

const NAMED: Record<string, { displayName: string; command: string; hint: string }> = {
  claude: {
    displayName: "Claude Code",
    command: "claude",
    hint: "https://docs.anthropic.com/en/docs/claude-code",
  },
  codex: {
    displayName: "OpenAI Codex CLI",
    command: "codex",
    hint: "https://github.com/openai/codex",
  },
  gemini: {
    displayName: "Gemini CLI",
    command: "gemini",
    hint: "https://github.com/google-gemini/gemini-cli",
  },
};

/**
 * Resolve an adapter for an agent id. Uses a named adapter when known; otherwise
 * builds a GenericAdapter from the config entry (vendor-neutral extensibility).
 */
/**
 * Sensible default env allow-list per named agent, so `yuhi run <agent>` "just
 * works" (DX-first) while still not inheriting the entire parent environment.
 * Subscription auth via the agent's config dir works because HOME is passed too.
 */
const AGENT_ENV_PASSTHROUGH: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
};

export function defaultEnvPassthrough(agentId: string): string[] {
  return AGENT_ENV_PASSTHROUGH[agentId] ?? [];
}

export function buildAdapter(agentId: string, config?: AgentConfigLike): AgentAdapter {
  if (agentId === "dummy") return new DummyAdapter();

  const named = NAMED[agentId];
  const command = config?.command ?? named?.command ?? agentId;
  const displayName = named?.displayName ?? agentId;
  const hint = named?.hint;
  return new GenericAdapter(agentId, displayName, command, config?.args ?? [], hint);
}

export const KNOWN_AGENT_IDS = Object.keys(NAMED);
