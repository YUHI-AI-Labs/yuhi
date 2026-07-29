import { describe, it, expect } from "vitest";
import { LocalModelError, type LocalModelProvider } from "@yuhi/shared";
import { runLocalPreparation } from "@yuhi/core";

const CSV = "name,student_id,score\nTanaka Aoi,S-10241,42\nSato Ren,S-10242,88\n";

function provider(gen: (p: string) => Promise<string>): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "",
    defaultModel: "m",
    async health() {
      return { ok: true, detail: "", endpoint: "" };
    },
    async listModels() {
      return ["m"];
    },
    generate: gen,
  };
}

describe("runLocalPreparation (async summarize → pseudonymize → safety-check)", () => {
  it("summarizes then pseudonymizes; status ok; original string untouched", async () => {
    const original = CSV;
    const p = provider(async () => "Summary: two students with scores 42 and 88.");
    const r = await runLocalPreparation(original, ["summarize-local", "pseudonymize", "safety-check"], {
      provider: p,
    });
    expect(r.status).toBe("ok");
    expect(r.allowed).toBe(true);
    expect(r.output).toMatch(/Summary/);
    expect(r.reduction.beforeChars).toBe(CSV.length);
    expect(original).toBe(CSV); // input not mutated
  });

  it("blocks when the summary still contains a protected identifier", async () => {
    // Provider leaks an identifier; no pseudonymize step → safety-check must block.
    const p = provider(async () => "The student Tanaka Aoi scored 42.");
    const r = await runLocalPreparation(CSV, ["summarize-local", "safety-check"], { provider: p });
    expect(r.status).toBe("blocked");
    expect(r.allowed).toBe(false);
  });

  it("errors clearly when summarize-local is requested without a provider", async () => {
    const r = await runLocalPreparation(CSV, ["summarize-local", "safety-check"], {});
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/provider/i);
  });

  it("surfaces provider failure as status=error (Ollama unavailable)", async () => {
    const p = provider(async () => {
      throw new LocalModelError("NOT_RUNNING", "Ollama not reachable");
    });
    const r = await runLocalPreparation(CSV, ["summarize-local"], { provider: p });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/NOT_RUNNING/);
  });
});
