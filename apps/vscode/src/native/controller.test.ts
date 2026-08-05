/**
 * v0.4.8 Phase 4 — Privacy Mode propagation into Native GUI Mode's broker config.
 * `controller.ts` has no `vscode` import, so it is directly testable with a mocked host.
 */
import { describe, expect, it } from "vitest";

import { startNativeSessionViaBroker, type NativeControllerHost } from "./controller.js";

function baseHost(): NativeControllerHost {
  return {
    log: () => {},
    showMessage: () => {},
    showWarning: () => {},
    choose: async () => undefined,
    spawnBroker: () => {},
    readHandshake: async () => ({ sessionId: "ngui_test", sessionRoot: "/root", pid: 1 }),
    writeJson: async () => {},
    delay: async () => {},
    now: () => 0,
  };
}

describe("startNativeSessionViaBroker — Privacy Mode propagation", () => {
  it("writes privacyMode/privacyModeAcknowledged into the broker config when given", async () => {
    let captured: Record<string, unknown> | undefined;
    const withCapture: NativeControllerHost = {
      ...baseHost(),
      writeJson: async (_path, value) => {
        captured = value as Record<string, unknown>;
      },
    };
    await startNativeSessionViaBroker(withCapture, {
      sourceWorkspace: "/src",
      preparedWorkspace: "/prepared",
      deliveryMode: "developer",
      privacyMode: "strict",
      privacyModeAcknowledged: true,
      retrievalMode: "disabled",
      configPath: "/tmp/config.json",
      handshakePath: "/tmp/handshake.json",
    });
    expect(captured?.["privacyMode"]).toBe("strict");
    expect(captured?.["privacyModeAcknowledged"]).toBe(true);
  });

  it("omits privacyMode when not given, so the broker falls back to legacy deliveryMode mapping", async () => {
    let captured: Record<string, unknown> | undefined;
    const withCapture: NativeControllerHost = {
      ...baseHost(),
      writeJson: async (_path, value) => {
        captured = value as Record<string, unknown>;
      },
    };
    await startNativeSessionViaBroker(withCapture, {
      sourceWorkspace: "/src",
      preparedWorkspace: "/prepared",
      deliveryMode: "strict",
      retrievalMode: "disabled",
      configPath: "/tmp/config.json",
      handshakePath: "/tmp/handshake.json",
    });
    expect(captured?.["deliveryMode"]).toBe("strict");
    expect("privacyMode" in (captured ?? {})).toBe(false);
  });
});
