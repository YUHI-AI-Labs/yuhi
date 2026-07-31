import { describe, expect, it } from "vitest";
import { defaultConfig, renderConfigYaml } from "./defaults.js";

describe("credential-safe defaults", () => {
  it("sanitizes environment and structured credential files", () => {
    const config = defaultConfig("synthetic");
    expect(config.rules).toContainEqual(expect.objectContaining({
      name: "sanitize-environment-files",
      action: "prepare-locally",
      processors: ["sanitize-environment", "safety-check"],
    }));
    expect(config.rules).toContainEqual(expect.objectContaining({
      name: "sanitize-credential-files",
      action: "prepare-locally",
      processors: ["sanitize-credentials", "safety-check"],
    }));
  });

  it("keeps private-key file types local", () => {
    const yaml = renderConfigYaml("synthetic");
    expect(yaml).toContain('name: block-private-key-files');
    expect(yaml).toContain('"**/*.pem"');
    expect(yaml).toContain('"**/*.key"');
    expect(yaml).toContain('"**/id_rsa"');
  });
});
