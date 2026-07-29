import { describe, it, expect } from "vitest";
import { LocalModelError, type LocalModelProvider } from "@yuhi/shared";
import { chunkText, createSummarizer } from "./summarize.js";

function fakeProvider(gen: (p: string) => Promise<string>): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "",
    defaultModel: "fake-model",
    async health() {
      return { ok: true, detail: "", endpoint: "" };
    },
    async listModels() {
      return ["fake-model"];
    },
    generate: gen,
  };
}

describe("chunkText", () => {
  it("keeps small text as one chunk", () => {
    expect(chunkText("hello\nworld", 1000)).toEqual(["hello\nworld"]);
  });
  it("splits large text on line boundaries", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text); // lossless recombination
  });
  it("returns [] for empty input", () => {
    expect(chunkText("", 100)).toEqual([]);
  });
});

describe("summarize-local processor", () => {
  it("summarizes a single chunk (one model call)", async () => {
    let calls = 0;
    const p = fakeProvider(async () => {
      calls++;
      return "short summary";
    });
    const r = await createSummarizer({ provider: p }).process("some content to summarize");
    expect(r.output).toBe("short summary");
    expect(calls).toBe(1);
    expect(r.audit.processorId).toBe("summarize-local");
    expect(r.safePreview).toMatch(/Summarized/);
  });

  it("chunks + consolidates large input", async () => {
    const prompts: string[] = [];
    const p = fakeProvider(async (prompt) => {
      prompts.push(prompt);
      return "s".repeat(20);
    });
    const big = Array.from({ length: 40 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
    const r = await createSummarizer({ provider: p, chunkChars: 200 }).process(big);
    // multiple chunk summaries + one consolidation call
    expect(prompts.length).toBeGreaterThan(2);
    expect(r.output.length).toBeLessThan(big.length);
    expect(r.audit.itemsChanged).toBeGreaterThan(1);
  });

  it("reports size reduction", async () => {
    const p = fakeProvider(async () => "tiny");
    const r = await createSummarizer({ provider: p }).process("x".repeat(1000));
    expect(r.safePreview).toMatch(/% smaller/);
  });

  it("caps chunks and marks partial", async () => {
    const p = fakeProvider(async () => "s");
    const big = Array.from({ length: 60 }, (_, i) => `l${i} ${"z".repeat(80)}`).join("\n");
    const r = await createSummarizer({ provider: p, chunkChars: 120, maxChunks: 3 }).process(big);
    expect(r.safePreview).toMatch(/partial/i);
    expect(r.audit.note).toMatch(/omitted/);
  });

  it("propagates provider errors (timeout/unavailable)", async () => {
    const p = fakeProvider(async () => {
      throw new LocalModelError("TIMEOUT", "timed out");
    });
    await expect(createSummarizer({ provider: p }).process("content")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});
