import { describe, expect, it } from "vitest";
import { buildMaskedPatchDiff } from "./review-diff.js";

describe("masked patch diff", () => {
  it("masks secrets and personal data on both sides", () => {
    const secret = `sk-proj-${"a".repeat(24)}`;
    const email = "synthetic.person@example.com";
    const diff = buildMaskedPatchDiff("generated.txt", `old=${secret}`, `token=${secret}\ncontact=${email}`);
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(email);
    expect(diff.maskedCategories).toEqual(["personal-data", "secret"]);
  });

  it("masks an entire private-key block rather than only its header", () => {
    const keyBody = "SYNTHETIC_PRIVATE_KEY_BODY_MUST_NOT_RENDER";
    const diff = buildMaskedPatchDiff("generated.pem", "", `-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----`);
    expect(JSON.stringify(diff)).not.toContain(keyBody);
    expect(diff.after).toBe("[REDACTED SECRET]");
  });
});
