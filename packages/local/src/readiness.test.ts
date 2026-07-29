import { describe, it, expect } from "vitest";
import { LocalModelError, type LocalModelProvider } from "@yuhi/shared";
import { localModelReadiness } from "./readiness.js";

function provider(over: Partial<LocalModelProvider> & { models?: string[]; healthOk?: boolean }): LocalModelProvider {
  const models = over.models ?? ["qwen3:1.7b"];
  const healthOk = over.healthOk ?? true;
  return {
    id: "fake",
    endpoint: "http://127.0.0.1:11434",
    defaultModel: "qwen3:1.7b",
    async health() {
      return { ok: healthOk, detail: "", endpoint: "", ...(healthOk ? { models } : {}) };
    },
    async listModels() {
      return models;
    },
    generate: over.generate ?? (async () => "OK"),
  };
}

describe("localModelReadiness", () => {
  it("1) API + model + generation succeeds → ready", async () => {
    const r = await localModelReadiness(provider({ generate: async () => "OK" }));
    expect(r.state).toBe("ready");
    expect(r.inference.ok).toBe(true);
  });

  it("2) generation HTTP 500 → inference-failed (with reason)", async () => {
    const r = await localModelReadiness(
      provider({
        generate: async () => {
          throw new LocalModelError("REQUEST_FAILED", "Ollama chat returned HTTP 500.");
        },
      }),
    );
    expect(r.state).toBe("inference-failed");
    expect(r.inference.ok).toBe(false);
    expect(r.inference.reason).toMatch(/REQUEST_FAILED/);
  });

  it("3) generation timeout → inference-failed", async () => {
    const r = await localModelReadiness(
      provider({
        generate: async () => {
          throw new LocalModelError("TIMEOUT", "timed out");
        },
      }),
      { timeoutMs: 10 },
    );
    expect(r.state).toBe("inference-failed");
    expect(r.inference.reason).toMatch(/TIMEOUT/);
  });

  it("4) model not installed → model-missing (no inference attempted)", async () => {
    let called = false;
    const r = await localModelReadiness(
      provider({
        models: ["gemma2:2b"],
        generate: async () => {
          called = true;
          return "OK";
        },
      }),
    );
    expect(r.state).toBe("model-missing");
    expect(called).toBe(false);
  });

  it("5) API unavailable → stopped (no inference attempted)", async () => {
    const r = await localModelReadiness(provider({ healthOk: false }));
    expect(r.state).toBe("stopped");
    expect(r.apiReachable).toBe(false);
  });

  it("empty generation output → inference-failed", async () => {
    const r = await localModelReadiness(provider({ generate: async () => "   " }));
    expect(r.state).toBe("inference-failed");
  });
});
