import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { YUHI_VERSION } from "./version.js";

/**
 * Version drift guard.
 *
 * `YUHI_VERSION` is written into the Context Manifest's `generator.version`, the audit
 * log, the workspace manifest and background `processorVersion` idempotency keys. It sat
 * at "0.1.0" through 0.4.5 — `packages/shared`'s own internal package version, which
 * never tracked a release — so every manifest and audit record up to 0.4.5 claims a
 * version Yuhi has not shipped since its first prototype.
 *
 * It must be a literal (shared is bundled into both the CLI and the extension, so there
 * is no single package.json to read at runtime). This test is what keeps the literal
 * honest: bump a release without updating it and CI fails here.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const versionOf = (rel: string): string =>
  (JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")) as { version: string }).version;

describe("YUHI_VERSION", () => {
  it("matches the published CLI version", () => {
    expect(YUHI_VERSION).toBe(versionOf("apps/cli/package.json"));
  });

  it("matches the published extension version", () => {
    expect(YUHI_VERSION).toBe(versionOf("apps/vscode/package.json"));
  });

  it("is a real semver release, not the shared package's internal version", () => {
    expect(YUHI_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    // The exact value that drifted, guarded so the mistake cannot be reintroduced.
    expect(YUHI_VERSION).not.toBe("0.1.0");
    expect(YUHI_VERSION).not.toBe(versionOf("packages/shared/package.json"));
  });
});
