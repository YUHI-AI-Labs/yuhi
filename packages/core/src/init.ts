import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderConfigYaml, toJsonSchema } from "@yuhi/config";
import { CONFIG_FILENAME } from "@yuhi/shared";
import { assertDirectory } from "./context.js";

export interface InitOptions {
  force?: boolean;
}

export interface InitResult {
  root: string;
  configPath: string;
  created: string[];
  alreadyExisted: boolean;
}

/**
 * Initialize a project: write yuhi.yaml + .yuhi/yuhi.schema.json. Never touches
 * source files. Respects an existing yuhi.yaml unless `force`.
 */
export function runInit(dir: string, options: InitOptions = {}): InitResult {
  const root = assertDirectory(dir);
  const configPath = path.join(root, CONFIG_FILENAME);
  const created: string[] = [];

  const alreadyExisted = existsSync(configPath);
  if (alreadyExisted && !options.force) {
    return { root, configPath, created, alreadyExisted: true };
  }

  const projectName = path.basename(root);
  writeFileSync(configPath, renderConfigYaml(projectName), { encoding: "utf8" });
  created.push(CONFIG_FILENAME);

  const yuhiDir = path.join(root, ".yuhi");
  if (!existsSync(yuhiDir)) mkdirSync(yuhiDir, { recursive: true });
  const schemaPath = path.join(yuhiDir, "yuhi.schema.json");
  writeFileSync(schemaPath, JSON.stringify(toJsonSchema(), null, 2), { encoding: "utf8" });
  created.push(path.join(".yuhi", "yuhi.schema.json"));

  // Local, per-project ignore for Yuhi's own artifacts (kept minimal).
  const gitkeep = path.join(yuhiDir, ".gitignore");
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "# Yuhi local artifacts\ncache/\n", { encoding: "utf8" });
    created.push(path.join(".yuhi", ".gitignore"));
  }

  return { root, configPath, created, alreadyExisted: false };
}
