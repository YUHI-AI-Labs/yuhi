import { describe, expect, it } from "vitest";
import { CompressorRegistry } from "./registry.js";
import { LargeArtifactCompressor } from "./large-artifact-compressor.js";

describe("LargeArtifactCompressor", () => {
  const registry = () => new CompressorRegistry().register(new LargeArtifactCompressor());

  it("creates a key-only JSON representation while keeping values out", async () => {
    const secret = "synthetic-sensitive-value-never-copy";
    const content = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, profile: { name: secret, score: 90 } })));
    const result = await registry().compress({ relpath: "large.json", content });
    expect(result.representation).toBe("compressed");
    expect(result.content).toContain("profile.name");
    expect(result.content).not.toContain(secret);
  });

  it("summarizes CSV shape without row values", async () => {
    const rows = ["name,score", ...Array.from({ length: 1500 }, (_, i) => `Synthetic Person ${i},${i % 100}`)].join("\n");
    const result = await registry().compress({ relpath: "large.csv", content: rows });
    expect(result.representation).toBe("compressed");
    expect(result.content).toContain("Rows: 1500");
    expect(result.content).not.toContain("Synthetic Person 1499");
  });

  it("falls back to FULL on malformed JSON", async () => {
    const content = `{${"x".repeat(20_000)}`;
    const result = await registry().compress({ relpath: "broken.json", content });
    expect(result.representation).toBe("full");
    expect(result.content).toBe(content);
    expect(result.warnings[0]?.code).toBe("parse-failed");
  });
});
