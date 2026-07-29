import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliVersion } from "./version.js";

const pkgVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

describe("cliVersion", () => {
  it("reports the package.json version (single authoritative source)", () => {
    expect(cliVersion()).toBe(pkgVersion);
  });

  it("is a non-empty semver-shaped string, never the stale 0.1.0 default", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    // guards the beta.1 defect where --version reported 0.1.0 while the package was 0.2.0-beta.1
    expect(cliVersion()).toBe(pkgVersion);
  });
});
