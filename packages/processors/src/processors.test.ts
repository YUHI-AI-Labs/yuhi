import { describe, it, expect } from "vitest";
import { createPseudonymizer, stableToken, inMemoryMappingStore } from "./pseudonymize.js";
import { createValidator } from "./validate.js";
import { parseDotenv } from "./dotenv.js";

describe("pseudonymize (rule-based)", () => {
  it("gives the same token for the same value (stable)", () => {
    expect(stableToken("Tanaka Aoi", "s", "Subject")).toBe(stableToken("Tanaka Aoi", "s", "Subject"));
    expect(stableToken("Tanaka Aoi", "s", "Subject")).not.toBe(stableToken("Sato Ren", "s", "Subject"));
  });

  it("replaces identifiers and keeps the original out of the output", async () => {
    const store = inMemoryMappingStore();
    const p = createPseudonymizer({ identifiers: ["Tanaka Aoi", "S-10241"], salt: "demo", store });
    const r = await p.process("Tanaka Aoi (S-10241) scored 42");
    expect(r.output).not.toContain("Tanaka Aoi");
    expect(r.output).not.toContain("S-10241");
    expect(r.output).toMatch(/Subject-[0-9A-F]{6}/);
    expect(r.externalTransmissionAllowed).toBe(true);
    expect(r.audit.itemsChanged).toBe(2);
  });

  it("keeps the mapping local and reversible; audit has no raw values", async () => {
    const store = inMemoryMappingStore();
    const p = createPseudonymizer({ identifiers: ["Alice"], salt: "x", store });
    const r = await p.process("Alice and Alice again");
    const token = store.entries()[0]![0];
    expect(store.get(token)).toBe("Alice"); // reversible, locally
    expect(JSON.stringify(r.audit)).not.toContain("Alice"); // no raw value in audit
    expect(r.audit.itemsChanged).toBe(2);
  });
});

describe("safety-check (validation)", () => {
  it("passes when no forbidden value is present", async () => {
    const v = createValidator({ forbid: ["Tanaka Aoi", "S-10241"], labels: ["name", "id"] });
    const r = await v.process("Subject-ABC123 scored in band 40-49");
    expect(r.validation?.ok).toBe(true);
    expect(r.externalTransmissionAllowed).toBe(true);
  });

  it("fails (and blocks transmission) when a raw value survived", async () => {
    const v = createValidator({ forbid: ["Tanaka Aoi"], labels: ["name"] });
    const r = await v.process("Tanaka Aoi is still here");
    expect(r.validation?.ok).toBe(false);
    expect(r.externalTransmissionAllowed).toBe(false);
    expect(r.validation?.problems[0]).toContain("name");
  });
});

describe("parseDotenv (runtime-only route)", () => {
  it("parses keys, strips quotes, ignores comments and export", () => {
    const env = parseDotenv(`# comment\nexport API_KEY="sk-123"\nDB='postgres://x'\n\nBAD LINE\nPORT=3000`);
    expect(env.API_KEY).toBe("sk-123");
    expect(env.DB).toBe("postgres://x");
    expect(env.PORT).toBe("3000");
    expect(Object.keys(env)).not.toContain("BAD LINE");
  });
});
