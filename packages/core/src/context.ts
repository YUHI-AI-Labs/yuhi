import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig, type LoadedConfig } from "@yuhi/config";
import { YuhiError } from "@yuhi/shared";

export interface YuhiContext extends LoadedConfig {
  root: string;
}

export function assertDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new YuhiError("NOT_A_DIRECTORY", `Not a directory: ${dir}`, {
      hint: "Point Yuhi at a project directory (the repo root).",
    });
  }
  return resolved;
}

/** Load config for a project directory. Throws CONFIG_NOT_FOUND if not initialized. */
export async function loadContext(dir: string): Promise<YuhiContext> {
  const root = assertDirectory(dir);
  const loaded = await loadConfig(root);
  return { ...loaded, root };
}
