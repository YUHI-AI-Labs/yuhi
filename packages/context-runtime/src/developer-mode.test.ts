/**
 * Developer Mode (v0.4.0 default) — the tests the policy change stands or falls on.
 *
 * The bargain is precise: a project's configuration REACHES the agent, and a raw value
 * NEVER reaches Yuhi's logs, evidence, statistics or UI. Every test here checks one half of
 * that, and the last one checks that Strict Mode remains available as a policy object
 * rather than a branch someone has to re-add.
 */

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { DEVELOPER_MODE_POLICY, DEVELOPER_MODE_NOTICE, STRICT_MODE_POLICY, policyForMode } from "./delivery-policy.js";
import { privateMetadata } from "./event.js";
import { ContextRuntime } from "./pipeline.js";
import { detectSecretValues, fingerprint, redactKeyMaterial, scanAndRedact } from "./safety.js";

const SESSION = asSessionId("dev-mode");
/** Synthetic, non-functional. Shaped like the real thing so the detectors fire. */
const SYNTHETIC_KEY = "sk-ant-api03-SYNTHETIC0000000000000000000000000000000000000000000000000000";
const AWS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const PEM = "-----BEGIN RSA PRIVATE KEY-----";

const DOTENV = [
  "# service configuration",
  "API_URL=https://api.staging.example.com",
  "MODEL_NAME=claude-sonnet-4-5",
  `SYNTHETIC_API_KEY=${SYNTHETIC_KEY}`,
  `AWS_SECRET_ACCESS_KEY=${AWS_KEY}`,
  "TIMEOUT_MS=30000",
].join("\n");

async function runtime(mode: "developer" | "strict" = "developer"): Promise<{ rt: ContextRuntime; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-devmode-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-04T00:00:00.000Z" });
  return {
    rt: new ContextRuntime({ store, now: () => "2026-08-04T00:00:00.000Z", deliveryPolicy: policyForMode(mode) }),
    root,
  };
}

/** Every byte Yuhi wrote for this session: evidence, state, object metadata. */
async function everythingYuhiWrote(root: string): Promise<string> {
  const chunks: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // `objects/` IS the private store — it is supposed to hold the original bytes.
      if (full.includes(`${join("", "objects")}`)) continue;
      chunks.push(await readFile(full, "utf8").catch(() => ""));
    }
  };
  await walk(root);
  return chunks.join("\n");
}

describe(".env readability (Developer Mode default)", () => {
  it("delivers configuration values to the agent instead of masking them", async () => {
    const { rt } = await runtime();
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: DOTENV,
      privateMetadata: privateMetadata(),
    });

    if (delivery.status !== "delivered") throw new Error("Developer Mode must deliver .env");
    // The three things a configuration diagnosis needs.
    expect(delivery.text).toContain("API_URL=https://api.staging.example.com");
    expect(delivery.text).toContain("MODEL_NAME=claude-sonnet-4-5");
    expect(delivery.text).toContain(SYNTHETIC_KEY);
  });

  it("still masks key material, in Developer Mode as in every mode", async () => {
    const { rt } = await runtime();
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: `${DOTENV}\nTLS_KEY="${PEM}MIIEowIBAAKCAQEA7Zx9qQ2vTn0lKpZs3mWf"`,
      privateMetadata: privateMetadata(),
    });

    if (delivery.status !== "delivered") throw new Error("expected delivery, not a refusal");
    // The private key is gone; the rest of the file is not.
    expect(delivery.text).not.toContain(PEM);
    expect(delivery.text).toContain("API_URL=https://api.staging.example.com");
    expect(delivery.text).toContain(SYNTHETIC_KEY);
  });

  it("records what it found without recording what it was", async () => {
    const { rt, root } = await runtime();
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: DOTENV,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    const record = explanation?.record;
    expect(record?.deliveryPolicy).toBe("developer");
    expect(record?.safetyFindings.length).toBeGreaterThan(0);
    // Type, count, source object, policy and hash — that is the whole permitted set.
    expect(record?.secretFingerprints?.length).toBeGreaterThan(0);
    expect(record?.secretFingerprints).toContain(fingerprint(AWS_KEY));
    expect(JSON.stringify(record)).not.toContain(AWS_KEY);
    expect(JSON.stringify(record)).not.toContain(SYNTHETIC_KEY);

    // And nothing Yuhi wrote anywhere carries the value.
    const written = await everythingYuhiWrote(root);
    expect(written).not.toContain(AWS_KEY);
    expect(written).not.toContain(SYNTHETIC_KEY);
    expect(written).toContain("developer");
  });
});

describe("strict compatibility", () => {
  it("keeps 0.3.x behaviour available as a policy, not a rewrite", async () => {
    const { rt } = await runtime("strict");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: DOTENV,
      privateMetadata: privateMetadata(),
    });

    if (delivery.status !== "delivered") throw new Error("expected a masked delivery");
    expect(delivery.text).not.toContain(SYNTHETIC_KEY);
    expect(delivery.text).not.toContain(AWS_KEY);
    // Variable names survive even under strict masking, so the shape is still diagnosable.
    expect(delivery.text).toContain("API_URL=");
  });

  it("exposes the two policies as data the scanner knows nothing about", () => {
    expect(DEVELOPER_MODE_POLICY.redactSecretsBeforeDelivery).toBe(false);
    expect(STRICT_MODE_POLICY.redactSecretsBeforeDelivery).toBe(true);
    expect(DEVELOPER_MODE_POLICY.maskValuesInEvidence).toBe(true);
    expect(STRICT_MODE_POLICY.maskValuesInEvidence).toBe(true);
    // Key material is refused in both.
    expect(DEVELOPER_MODE_POLICY.hardBlockedCategories).toEqual(STRICT_MODE_POLICY.hardBlockedCategories);
    expect(policyForMode("strict").mode).toBe("strict");
    expect(policyForMode("developer").mode).toBe("developer");
  });

  it("says plainly what Developer Mode does, without implying secrets are withheld", () => {
    expect(DEVELOPER_MODE_NOTICE).toContain("may be available to Claude Code");
    expect(DEVELOPER_MODE_NOTICE).toContain("not written to Yuhi logs, evidence, or UI");
    expect(DEVELOPER_MODE_NOTICE).not.toMatch(/secrets are (removed|masked|never sent)/i);
  });
});

describe("primitives", () => {
  it("masks only key material and leaves ordinary configuration intact", () => {
    const result = redactKeyMaterial(`${DOTENV}\nTLS_KEY="${PEM}abc"`, DEVELOPER_MODE_POLICY);
    expect(result.text).not.toContain(PEM);
    expect(result.text).toContain(SYNTHETIC_KEY);
    expect(result.categories).toContain("private-key");
  });

  it("fingerprints values without keeping them", () => {
    const scan = scanAndRedact(DOTENV);
    expect(scan.fingerprints.length).toBeGreaterThan(0);
    expect(scan.fingerprints.join(" ")).not.toContain(AWS_KEY);
    expect(scan.fingerprints.every((f) => /^[0-9a-f]{16}$/.test(f))).toBe(true);
  });

  it("finds the values the egress guard must watch, including plain KEY=VALUE lines", () => {
    const values = detectSecretValues(DOTENV);
    expect(values).toContain(AWS_KEY);
    expect(values).toContain(SYNTHETIC_KEY);
    // A short, non-secret value is not worth watching.
    expect(values).not.toContain("30000");
  });
});
