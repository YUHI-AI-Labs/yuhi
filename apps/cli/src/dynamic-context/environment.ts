/**
 * Environment detection and child-environment construction for the dynamic runtime
 * (spec §11).
 *
 * Two hard rules:
 *  - Do not break the user's existing provider setup. Bedrock and Vertex do not speak
 *    the Anthropic Messages API at an `ANTHROPIC_BASE_URL`, so dynamic context is
 *    refused for them rather than silently corrupting their traffic. An enterprise
 *    gateway already in `ANTHROPIC_BASE_URL` is CHAINED, not replaced.
 *  - Never log, store, or write a credential value. Presence is checked; value never read.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UpstreamMode = "anthropic-api" | "subscription" | "enterprise-gateway" | "bedrock" | "vertex";

export interface UpstreamConfig {
  readonly mode: UpstreamMode;
  readonly baseUrl: string;
  /** false = the dynamic gateway must not be inserted for this provider. */
  readonly supportsDynamicContext: boolean;
  readonly note?: string;
}

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export function detectUpstream(env: NodeJS.ProcessEnv = process.env): UpstreamConfig {
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1" || env["CLAUDE_CODE_USE_BEDROCK"] === "true") {
    return {
      mode: "bedrock",
      baseUrl: "",
      supportsDynamicContext: false,
      note: "Claude Code is configured for Amazon Bedrock, which does not use ANTHROPIC_BASE_URL. Dynamic context is unavailable without breaking that setup.",
    };
  }
  if (env["CLAUDE_CODE_USE_VERTEX"] === "1" || env["CLAUDE_CODE_USE_VERTEX"] === "true") {
    return {
      mode: "vertex",
      baseUrl: "",
      supportsDynamicContext: false,
      note: "Claude Code is configured for Google Vertex AI, which does not use ANTHROPIC_BASE_URL. Dynamic context is unavailable without breaking that setup.",
    };
  }
  const existing = env["ANTHROPIC_BASE_URL"];
  if (existing && existing.trim() !== "" && !isLoopback(existing)) {
    return {
      mode: "enterprise-gateway",
      baseUrl: existing.trim(),
      supportsDynamicContext: true,
      note: "An existing ANTHROPIC_BASE_URL was detected and will be used as the upstream (chained, not replaced).",
    };
  }
  if (env["ANTHROPIC_API_KEY"] || env["ANTHROPIC_AUTH_TOKEN"]) {
    return { mode: "anthropic-api", baseUrl: ANTHROPIC_DEFAULT_BASE_URL, supportsDynamicContext: true };
  }
  return {
    mode: "subscription",
    baseUrl: ANTHROPIC_DEFAULT_BASE_URL,
    supportsDynamicContext: true,
    note: "No API key in the environment. Claude Code will use its own stored credentials; Yuhi forwards them without reading them.",
  };
}

function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(url.trim());
}

/** Credential PRESENCE only — the value is never read into a variable we return. */
export function credentialPresence(env: NodeJS.ProcessEnv = process.env, home = homedir()): {
  apiKeyPresent: boolean;
  authTokenPresent: boolean;
  storedCredentialsPresent: boolean;
} {
  return {
    apiKeyPresent: typeof env["ANTHROPIC_API_KEY"] === "string" && env["ANTHROPIC_API_KEY"] !== "",
    authTokenPresent: typeof env["ANTHROPIC_AUTH_TOKEN"] === "string" && env["ANTHROPIC_AUTH_TOKEN"] !== "",
    storedCredentialsPresent:
      existsSync(join(home, ".claude", ".credentials.json")) || existsSync(join(home, ".claude.json")),
  };
}

export interface DynamicEnvInput {
  readonly gatewayUrl: string;
  readonly sessionId: string;
  readonly contextRoot: string;
  readonly mcpConfigPath?: string;
}

/**
 * The variables added to the agent's environment. Deliberately small: the adapter still
 * owns the base environment (THREAT_MODEL T7 minimal env), and Yuhi only points the
 * agent at the loopback gateway and tells the MCP server where the store is.
 */
export function dynamicContextEnv(input: DynamicEnvInput): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    YUHI_DYNAMIC_CONTEXT: "1",
    YUHI_SESSION_ID: input.sessionId,
    YUHI_CONTEXT_ROOT: input.contextRoot,
    ...(input.mcpConfigPath ? { YUHI_MCP_CONFIG: input.mcpConfigPath } : {}),
  };
}

/** The `.mcp.json` fragment registering Yuhi's retrieval server with Claude Code. */
export function mcpConfig(input: { cliEntry: string; contextRoot: string; sessionId: string; nodeExecutable?: string }): {
  mcpServers: Record<string, unknown>;
} {
  return {
    mcpServers: {
      yuhi: {
        command: input.nodeExecutable ?? process.execPath,
        args: [input.cliEntry, "mcp", "serve"],
        env: {
          YUHI_CONTEXT_ROOT: input.contextRoot,
          YUHI_SESSION_ID: input.sessionId,
        },
      },
    },
  };
}
