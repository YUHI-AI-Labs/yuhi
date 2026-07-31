/**
 * v0.3.3 compression PLAN helpers — deterministic MustKeep signal derivation.
 *
 * Purely path-based, synchronous, and side-effect free: given a repo-relative POSIX
 * relpath it names the budget MustKeep signals that must be true for that file so the
 * token budget never excludes or force-compresses it. Kept separate from the prepare
 * pipeline so the mapping is unit-testable in isolation and never grows a per-file
 * switch inside `prepareWorkspace`.
 *
 * This module NEVER imports the compression parser (or `typescript`): it is pure string
 * work, so importing it can never trigger the lazy TypeScript load.
 */

import path from "node:path";

/** Source extensions a structure compressor can operate on (used by the entry-point heuristic). */
const SOURCE_ENTRY_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Extensions that are always configuration, regardless of location. */
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]);

/** Deterministic MustKeep signals derived from a relpath (all optional booleans). */
export interface MustKeepSignals {
  entryPoint?: boolean;
  packageManifest?: boolean;
  configFile?: boolean;
  agentInstruction?: boolean;
}

function baseName(relpath: string): string {
  const normalized = relpath.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** A package/dependency manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.gemspec`). */
export function isPackageManifest(relpath: string): boolean {
  const base = baseName(relpath);
  if (base === "package.json") return true;
  if (base === "pyproject.toml") return true;
  if (base === "Cargo.toml") return true;
  if (base === "go.mod") return true;
  if (base.endsWith(".gemspec")) return true;
  return false;
}

/** A configuration file: known config extension, a dotfile rc, `tsconfig*.json`, or `*.config.*`. */
export function isConfigFile(relpath: string): boolean {
  const base = baseName(relpath).toLowerCase();
  const ext = path.posix.extname(base);
  if (CONFIG_EXTENSIONS.has(ext)) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  // Dotfile "rc" configs: .eslintrc, .prettierrc, .babelrc, .npmrc, .eslintrc.json ...
  if (/^\.[^.]*rc(\.[^.]+)?$/.test(base)) return true;
  // tsconfig.json, tsconfig.build.json ...
  if (base.startsWith("tsconfig") && base.endsWith(".json")) return true;
  // *.config.* (vite.config.ts, jest.config.js, tailwind.config.cjs ...)
  if (/\.config\.[^.]+$/.test(base)) return true;
  return false;
}

/** An agent-instruction file (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, GitHub Copilot instructions). */
export function isAgentInstruction(relpath: string): boolean {
  const normalized = relpath.replaceAll("\\", "/");
  const base = baseName(normalized);
  if (base === "CLAUDE.md" || base === "AGENTS.md" || base === ".cursorrules") return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  return false;
}

/**
 * A conservative "entry point" heuristic: `index`, `main`, or `cli` at the repo root
 * or directly under `src/`, and anything under a top-level `bin/`. Deliberately narrow
 * so the budget only ever protects genuine entry points, never every deep `index.ts`.
 */
export function isEntryPoint(relpath: string): boolean {
  const normalized = relpath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalized.startsWith("bin/")) return true;
  const ext = path.posix.extname(normalized);
  if (!SOURCE_ENTRY_EXTENSIONS.has(ext.toLowerCase())) return false;
  const dir = path.posix.dirname(normalized);
  const stem = baseName(normalized).slice(0, -ext.length).toLowerCase();
  if (dir !== "." && dir !== "src") return false;
  return stem === "index" || stem === "main" || stem === "cli";
}

/** Combine the individual path signals into the budget's MustKeep signal set. */
export function deriveMustKeepSignals(relpath: string): MustKeepSignals {
  const signals: MustKeepSignals = {};
  if (isEntryPoint(relpath)) signals.entryPoint = true;
  if (isPackageManifest(relpath)) signals.packageManifest = true;
  if (isConfigFile(relpath)) signals.configFile = true;
  if (isAgentInstruction(relpath)) signals.agentInstruction = true;
  return signals;
}
