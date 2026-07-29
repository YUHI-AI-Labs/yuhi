import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import {
  DEFAULT_LOCAL_MODEL,
  LocalModelError,
  type LocalModelConfig,
  type LocalModelProvider,
} from "@yuhi/shared";
import type { LocalModelSettings } from "@yuhi/config";
import { parseDocument } from "yaml";

/**
 * Map the yuhi.yaml `local_model:` block (snake_case, `timeout_ms`) onto the
 * @yuhi/shared LocalModelConfig shape (`timeoutMs`) used by
 * createLocalModelProvider. When the block is absent everything falls back to
 * DEFAULT_LOCAL_MODEL. Local only — no cloud endpoints are ever produced here.
 */
export function providerConfigFromSettings(
  settings: LocalModelSettings | undefined,
): Partial<LocalModelConfig> {
  if (!settings) return {};
  return {
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    timeoutMs: settings.timeout_ms,
  };
}

/** The configured (or default) model id for the local-model provider. */
export function configuredModel(settings: LocalModelSettings | undefined): string {
  return settings?.model ?? DEFAULT_LOCAL_MODEL.model;
}

/** Tolerant match: exact, or a `<name>:latest` / basename match for a bare id. */
export function isModelInstalled(installed: string[], model: string): boolean {
  if (installed.includes(model)) return true;
  if (installed.includes(`${model}:latest`)) return true;
  if (!model.includes(":")) return installed.some((m) => m.split(":")[0] === model);
  return false;
}

interface Tag {
  name: string;
  size?: number;
}

/**
 * Best-effort read of Ollama's /api/tags for live on-disk sizes. Never throws —
 * returns an empty map when Ollama is unreachable so callers fall back to the
 * approximate sizes in MODEL_TIERS.
 */
export async function fetchInstalledTags(endpoint: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, {
        method: "GET",
        signal: ctrl.signal,
      });
      if (!res.ok) return sizes;
      const body = (await res.json()) as { models?: Tag[] };
      for (const m of body.models ?? []) {
        if (typeof m.name === "string" && typeof m.size === "number") sizes.set(m.name, m.size);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* unreachable → empty map */
  }
  return sizes;
}

/** Human-readable size for a byte count (GB/MB), used for live Ollama sizes. */
export function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export interface PullResult {
  code: number | null;
  /** true when the pull was interrupted (Ctrl-C / SIGINT). */
  cancelled: boolean;
}

/**
 * Run `ollama pull <model>` with inherited stdio so the user sees native
 * progress. Ctrl-C is delivered to the child by the shared TTY; we resolve with
 * `cancelled: true` rather than killing the parent. NEVER downloads on its own —
 * the caller must have obtained explicit confirmation first.
 */
export function pullModel(model: string): Promise<PullResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", model], { stdio: "inherit" });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      const cancelled = signal === "SIGINT" || signal === "SIGTERM" || code === 130;
      resolve({ code, cancelled });
    });
  });
}

export interface SmokeResult {
  ok: boolean;
  detail: string;
}

/** Tiny local generate() to confirm the model actually answers. Never throws. */
export async function smokeTest(provider: LocalModelProvider, model: string): Promise<SmokeResult> {
  try {
    const out = await provider.generate("ping", {
      model,
      maxTokens: 16,
      timeoutMs: 30_000,
      temperature: 0,
    });
    return { ok: out.trim().length > 0, detail: "Model responded to a local test prompt." };
  } catch (e) {
    const err = e as LocalModelError;
    return { ok: false, detail: err.message ?? "Smoke test failed." };
  }
}

/**
 * Set `local_model.model` in an existing yuhi.yaml, preserving comments and
 * formatting via the YAML document API. Creates the `local_model` block if it is
 * absent. Only ever touches the model field.
 */
export async function writeModelToConfig(configPath: string, model: string): Promise<void> {
  const raw = await readFile(configPath, "utf8");
  const doc = parseDocument(raw);
  doc.setIn(["local_model", "model"], model);
  // Fill sensible siblings only when the block was just created.
  if (doc.getIn(["local_model", "provider"]) === undefined)
    doc.setIn(["local_model", "provider"], DEFAULT_LOCAL_MODEL.provider);
  if (doc.getIn(["local_model", "endpoint"]) === undefined)
    doc.setIn(["local_model", "endpoint"], DEFAULT_LOCAL_MODEL.endpoint);
  await writeFile(configPath, doc.toString(), "utf8");
}

/** OS-appropriate hint shown when the `ollama` binary is not on PATH. */
export function installHintForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS: download the app from the URL above, or `brew install ollama`.";
    case "win32":
      return "Windows: download and run the installer from the URL above.";
    case "linux":
      return "Linux: see the URL above (official script: `curl -fsSL https://ollama.com/install.sh | sh`).";
    default:
      return "See the URL above for installation instructions for your OS.";
  }
}

export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
