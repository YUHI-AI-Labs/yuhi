import { describe, it, expect } from "vitest";
import {
  deriveMustKeepSignals,
  isAgentInstruction,
  isConfigFile,
  isEntryPoint,
  isPackageManifest,
} from "./plan.js";

describe("compression plan — MustKeep signal derivation", () => {
  it("recognizes package manifests across ecosystems", () => {
    for (const rel of ["package.json", "pkg/pyproject.toml", "crate/Cargo.toml", "go.mod", "lib.gemspec"]) {
      expect(isPackageManifest(rel)).toBe(true);
    }
    expect(isPackageManifest("src/app.ts")).toBe(false);
  });

  it("recognizes config files (extensions, rc dotfiles, tsconfig, *.config.*)", () => {
    for (const rel of [
      "config.yaml",
      "settings.toml",
      ".env",
      ".env.production",
      ".eslintrc",
      ".prettierrc.json",
      "tsconfig.build.json",
      "vite.config.ts",
    ]) {
      expect(isConfigFile(rel)).toBe(true);
    }
    expect(isConfigFile("src/index.ts")).toBe(false);
  });

  it("recognizes agent-instruction files", () => {
    for (const rel of ["CLAUDE.md", "docs/AGENTS.md", ".cursorrules", ".github/copilot-instructions.md"]) {
      expect(isAgentInstruction(rel)).toBe(true);
    }
    expect(isAgentInstruction("README.md")).toBe(false);
  });

  it("is a conservative entry-point heuristic (root/src index|main|cli, and bin/)", () => {
    for (const rel of ["index.ts", "src/index.tsx", "src/main.js", "cli.mjs", "src/cli.ts", "bin/run.js"]) {
      expect(isEntryPoint(rel)).toBe(true);
    }
    // Deep index files and non-source files are NOT treated as entry points.
    expect(isEntryPoint("src/features/index.ts")).toBe(false);
    expect(isEntryPoint("src/index.css")).toBe(false);
    expect(isEntryPoint("README.md")).toBe(false);
  });

  it("combines individual signals into the MustKeep set", () => {
    expect(deriveMustKeepSignals("package.json")).toEqual({ packageManifest: true, configFile: true });
    expect(deriveMustKeepSignals("src/index.ts")).toEqual({ entryPoint: true });
    expect(deriveMustKeepSignals("src/feature.ts")).toEqual({});
  });
});
