import { describe, it, expect } from "vitest";
import { LocalModelError } from "@yuhi/shared";
import { createOllamaProvider } from "./ollama.js";

/** Minimal Response-like stub (code only uses ok/status/json/text). */
function res(init: { ok?: boolean; status?: number; json?: unknown; text?: string; badJson?: boolean }) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (init.badJson) throw new Error("bad json");
      return init.json;
    },
    text: async () => init.text ?? "",
  } as unknown as Response;
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** A fetch that never resolves until its signal aborts, then rejects. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const s = init?.signal;
    if (s?.aborted) return reject(abortError());
    s?.addEventListener("abort", () => reject(abortError()));
  })) as unknown as typeof fetch;

const TAGS = { models: [{ name: "gemma3:4b" }, { name: "qwen3:4b" }] };
const CHAT_OK = { choices: [{ message: { content: "a concise summary" } }] };

describe("OllamaProvider", () => {
  it("health() reports reachable + models", async () => {
    const p = createOllamaProvider({ fetchImpl: (async () => res({ json: TAGS })) as unknown as typeof fetch });
    const h = await p.health();
    expect(h.ok).toBe(true);
    expect(h.models).toEqual(["gemma3:4b", "qwen3:4b"]);
  });

  it("health() reports not reachable when connection fails (never throws)", async () => {
    const p = createOllamaProvider({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/not reachable/i);
  });

  it("listModels() returns installed names", async () => {
    const p = createOllamaProvider({ fetchImpl: (async () => res({ json: TAGS })) as unknown as typeof fetch });
    expect(await p.listModels()).toContain("gemma3:4b");
  });

  it("generate() returns the completion content", async () => {
    const p = createOllamaProvider({ fetchImpl: (async () => res({ json: CHAT_OK })) as unknown as typeof fetch });
    expect(await p.generate("summarize this")).toBe("a concise summary");
  });

  it("generate() maps a 404 to MODEL_NOT_FOUND", async () => {
    const p = createOllamaProvider({
      model: "missing:1b",
      fetchImpl: (async () => res({ ok: false, status: 404, text: '{"error":"model not found"}' })) as unknown as typeof fetch,
    });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("generate() maps an empty completion to MALFORMED_RESPONSE", async () => {
    const p = createOllamaProvider({ fetchImpl: (async () => res({ json: { choices: [] } })) as unknown as typeof fetch });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("generate() times out (TIMEOUT)", async () => {
    const p = createOllamaProvider({ timeoutMs: 20, fetchImpl: hangingFetch });
    await expect(p.generate("x")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("generate() honors caller cancellation (CANCELLED)", async () => {
    const p = createOllamaProvider({ timeoutMs: 5_000, fetchImpl: hangingFetch });
    const ac = new AbortController();
    ac.abort();
    await expect(p.generate("x", { signal: ac.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("errors are LocalModelError instances", async () => {
    const p = createOllamaProvider({
      fetchImpl: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    await p.generate("x").catch((e) => {
      expect(e).toBeInstanceOf(LocalModelError);
      expect(e.code).toBe("NOT_RUNNING");
    });
  });
});
