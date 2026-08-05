/**
 * v0.4.8 Phase 3B — `startDynamicClaudeSession` is the ONE shared entry point Dynamic
 * Terminal (CLI) and Native GUI (VS Code, Phase 4) both call, so Privacy Mode
 * resolution belongs here, not duplicated per surface.
 */
import { describe, expect, it } from "vitest";

import { startDynamicClaudeSession } from "./launch-session.js";
import type { GatewayHandle, GatewayStats } from "./server.js";

const STATS: GatewayStats = { upstream: "https://api.anthropic.com", startedAt: "2026-08-05T00:00:00.000Z", requests: 0, sessions: [] };

function fakeGateway(): GatewayHandle {
  return {
    url: "http://127.0.0.1:1",
    port: 1,
    storeRoot: "/tmp/does-not-matter",
    stats: () => STATS,
    close: async () => {},
  };
}

describe("startDynamicClaudeSession — Privacy Mode composition", () => {
  it("privacyMode wins over the legacy deliveryMode when both are given", async () => {
    let seen: Record<string, unknown> | undefined;
    const session = await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      privacyMode: "strict",
      deliveryMode: "developer", // ignored -- privacyMode takes precedence
      startGatewayImpl: async (o) => {
        seen = o as unknown as Record<string, unknown>;
        return fakeGateway();
      },
      readyProbe: async () => ({ ok: true }),
    });
    expect(session.privacyMode).toBe("strict");
    expect(session.deliveryMode).toBe("strict");
    expect(seen?.["privacyMode"]).toBe("strict");
    expect((seen?.["deliveryPolicy"] as { redactSecretsBeforeDelivery?: boolean } | undefined)?.redactSecretsBeforeDelivery).toBe(true);
  });

  it("balanced privacyMode composes to developer-delivery secret handling (dynamic-terminal surface)", async () => {
    let seen: Record<string, unknown> | undefined;
    const session = await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      privacyMode: "balanced",
      startGatewayImpl: async (o) => {
        seen = o as unknown as Record<string, unknown>;
        return fakeGateway();
      },
      readyProbe: async () => ({ ok: true }),
    });
    expect(session.deliveryMode).toBe("developer");
    expect((seen?.["deliveryPolicy"] as { redactSecretsBeforeDelivery?: boolean } | undefined)?.redactSecretsBeforeDelivery).toBe(false);
  });

  it("trusted-local privacyMode also composes to developer-delivery, with acknowledgement carried through", async () => {
    let seen: Record<string, unknown> | undefined;
    const session = await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      privacyMode: "trusted-local",
      privacyModeAcknowledged: true,
      startGatewayImpl: async (o) => {
        seen = o as unknown as Record<string, unknown>;
        return fakeGateway();
      },
      readyProbe: async () => ({ ok: true }),
    });
    expect(session.privacyMode).toBe("trusted-local");
    expect(seen?.["privacyMode"]).toBe("trusted-local");
  });

  it("no privacyMode: legacy deliveryMode maps through unchanged (byte-identical to pre-0.4.8 behavior)", async () => {
    let seen: Record<string, unknown> | undefined;
    const session = await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      deliveryMode: "strict",
      startGatewayImpl: async (o) => {
        seen = o as unknown as Record<string, unknown>;
        return fakeGateway();
      },
      readyProbe: async () => ({ ok: true }),
    });
    expect(session.deliveryMode).toBe("strict");
    expect(session.privacyMode).toBe("strict");
    expect((seen?.["deliveryPolicy"] as { redactSecretsBeforeDelivery?: boolean } | undefined)?.redactSecretsBeforeDelivery).toBe(true);
  });

  it("no privacyMode, no deliveryMode: defaults to balanced/developer, exactly as before v0.4.8", async () => {
    const session = await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      startGatewayImpl: async () => fakeGateway(),
      readyProbe: async () => ({ ok: true }),
    });
    expect(session.deliveryMode).toBe("developer");
    expect(session.privacyMode).toBe("balanced");
  });

  it("an aliasContext, when provided, is passed through to the gateway (cross-restart token stability, Phase 3B)", async () => {
    let seen: Record<string, unknown> | undefined;
    const aliasContext = { marker: "test-context" } as unknown as Parameters<
      typeof startDynamicClaudeSession
    >[0]["aliasContext"];
    await startDynamicClaudeSession({
      preparedWorkspace: "/prepared",
      privacyMode: "balanced",
      aliasContext,
      startGatewayImpl: async (o) => {
        seen = o as unknown as Record<string, unknown>;
        return fakeGateway();
      },
      readyProbe: async () => ({ ok: true }),
    });
    expect(seen?.["aliasContext"]).toBe(aliasContext);
  });
});
