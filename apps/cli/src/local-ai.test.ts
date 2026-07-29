import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalModelError, type LocalModelProvider } from "@yuhi/shared";
import type { LocalModelSettings } from "@yuhi/config";
import {
  providerConfigFromSettings,
  configuredModel,
  isModelInstalled,
  formatGB,
  smokeTest,
  writeModelToConfig,
  installHintForPlatform,
} from "./local-ai.js";

const settings: LocalModelSettings = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3:4b",
  timeout_ms: 90_000,
};

/** Minimal mock provider — no network, no Ollama. */
function mockProvider(over: Partial<LocalModelProvider> = {}): LocalModelProvider {
  return {
    id: "mock",
    endpoint: "http://127.0.0.1:11434",
    defaultModel: "qwen3:1.7b",
    health: async () => ({ ok: true, detail: "ok", endpoint: "http://127.0.0.1:11434", models: [] }),
    listModels: async () => [],
    generate: async () => "pong",
    ...over,
  };
}

describe("providerConfigFromSettings", () => {
  it("maps snake_case timeout_ms onto timeoutMs", () => {
    expect(providerConfigFromSettings(settings)).toEqual({
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      timeoutMs: 90_000,
    });
  });
  it("returns empty config when settings are absent (defaults apply downstream)", () => {
    expect(providerConfigFromSettings(undefined)).toEqual({});
  });
});

describe("configuredModel", () => {
  it("uses the configured model", () => {
    expect(configuredModel(settings)).toBe("qwen3:4b");
  });
  it("falls back to the default model", () => {
    expect(configuredModel(undefined)).toBe("qwen3:1.7b");
  });
});

describe("isModelInstalled", () => {
  it("matches exactly", () => {
    expect(isModelInstalled(["qwen3:1.7b", "llama3:8b"], "qwen3:1.7b")).toBe(true);
  });
  it("matches a bare id against a tagged install", () => {
    expect(isModelInstalled(["qwen3:1.7b"], "qwen3")).toBe(true);
  });
  it("matches :latest for a bare id", () => {
    expect(isModelInstalled(["mistral:latest"], "mistral")).toBe(true);
  });
  it("reports missing models", () => {
    expect(isModelInstalled(["llama3:8b"], "qwen3:1.7b")).toBe(false);
  });
});

describe("formatGB", () => {
  it("formats GB and MB", () => {
    expect(formatGB(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(formatGB(512 * 1024 ** 2)).toBe("512 MB");
  });
});

describe("smokeTest", () => {
  it("passes when the model responds", async () => {
    const r = await smokeTest(mockProvider(), "qwen3:1.7b");
    expect(r.ok).toBe(true);
  });
  it("fails gracefully on a LocalModelError", async () => {
    const provider = mockProvider({
      generate: async () => {
        throw new LocalModelError("MODEL_NOT_FOUND", "Model not installed.");
      },
    });
    const r = await smokeTest(provider, "qwen3:1.7b");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not installed");
  });
});

describe("writeModelToConfig", () => {
  it("sets local_model.model while preserving comments", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yuhi-cli-"));
    const file = path.join(dir, "yuhi.yaml");
    writeFileSync(file, '# my policy\nversion: "1"\nproject:\n  name: demo\n', "utf8");
    await writeModelToConfig(file, "qwen3:4b");
    const out = readFileSync(file, "utf8");
    expect(out).toContain("# my policy");
    expect(out).toContain("qwen3:4b");
    expect(out).toMatch(/local_model:/);
    expect(out).toMatch(/provider:\s*ollama/);
  });
});

describe("installHintForPlatform", () => {
  it("gives an OS-appropriate hint", () => {
    expect(installHintForPlatform("darwin")).toMatch(/macOS/);
    expect(installHintForPlatform("win32")).toMatch(/Windows/);
    expect(installHintForPlatform("linux")).toMatch(/Linux/);
  });
});
