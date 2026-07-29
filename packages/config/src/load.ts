import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_FILENAME, ALT_CONFIG_FILENAMES, YuhiError, sha256 } from "@yuhi/shared";
import { yuhiConfigSchema, type YuhiConfig } from "./schema.js";

export interface LoadedConfig {
  config: YuhiConfig;
  /** Absolute path of the yuhi.yaml that was loaded. */
  configPath: string;
  /** Deterministic hash of the normalized policy (for manifest/audit). */
  policyHash: string;
}

/** Canonical, stable stringify (sorted keys) for hashing. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export function parseConfig(raw: string, sourceLabel: string): LoadedConfig["config"] {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    throw new YuhiError("CONFIG_INVALID", `Could not parse ${sourceLabel}: not valid YAML.`, {
      hint: "Check indentation and quoting. See schemas/yuhi.schema.json for the expected shape.",
      cause: e,
    });
  }
  const result = yuhiConfigSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues
      .slice(0, 10)
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new YuhiError("CONFIG_INVALID", `${sourceLabel} is invalid:\n${problems}`, {
      hint: "Fix the fields above. Run `yuhi doctor` to re-validate.",
    });
  }
  return result.data;
}

export async function loadConfig(dir: string): Promise<LoadedConfig> {
  // Canonical yuhi.yaml first, then standard-looking alternates.
  const configPath = ALT_CONFIG_FILENAMES.map((name) => path.join(dir, name)).find((p) =>
    existsSync(p),
  );
  if (!configPath) {
    throw new YuhiError("CONFIG_NOT_FOUND", `No ${CONFIG_FILENAME} found in ${dir}.`, {
      hint: "Run `yuhi init` to create one.",
    });
  }
  const raw = await readFile(configPath, "utf8");
  const config = parseConfig(raw, path.basename(configPath));
  const policyHash = sha256(canonical(config)).slice(0, 16);
  return { config, configPath, policyHash };
}
