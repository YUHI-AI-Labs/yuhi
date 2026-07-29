import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME } from "@yuhi/shared";
import { cliVersion } from "./version.js";
import { buildAdapter, KNOWN_AGENT_IDS } from "@yuhi/core";
import { loadConfig } from "@yuhi/config";
import { createLocalModelProvider, localModelReadiness, INFERENCE_FAILURE_ACTIONS } from "@yuhi/local";
import { lookupOnPath } from "@yuhi/agents";
import type { Translator } from "./i18n.js";
import { ui, symbols, heading } from "./ui.js";
import { providerConfigFromSettings, configuredModel } from "./local-ai.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity: "info" | "warn" | "error";
}

/** Actionable overall state of the local-AI stack. */
export type LocalAiState =
  | "Ready"
  | "Ollama missing"
  | "Ollama stopped"
  | "Model missing"
  | "Inference failed"
  | "Workspace not writable"
  | "Configuration invalid";

export interface DoctorReport {
  yuhiVersion: string;
  nodeVersion: string;
  platform: string;
  checks: DoctorCheck[];
  issues: number;
  localAi: LocalAiState;
  /** Underlying reason when localAi is "Inference failed". */
  localAiReason?: string;
}

export async function runDoctor(dir: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: DoctorCheck["severity"] = ok ? "info" : "warn") =>
    checks.push({ name, ok, detail, severity });

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 20, `v${process.versions.node}`, major >= 20 ? "info" : "error");

  // Git
  const gitAdapter = buildAdapter("__git__", { command: "git" });
  add("git", await gitAdapter.detect(), "");

  // Agents
  for (const id of KNOWN_AGENT_IDS) {
    const a = buildAdapter(id);
    add(a.displayName, await a.detect(), await a.detect() ? "on PATH" : a.installHint(), "info");
  }

  // Config validity
  const resolvedDir = path.resolve(dir);
  const configPath = path.join(resolvedDir, CONFIG_FILENAME);
  let configValid = true;
  let localModelSettings: Awaited<ReturnType<typeof loadConfig>>["config"]["local_model"];
  if (existsSync(configPath)) {
    try {
      const loaded = await loadConfig(resolvedDir);
      localModelSettings = loaded.config.local_model;
      add("yuhi.yaml", true, "valid");
    } catch (e) {
      configValid = false;
      add("yuhi.yaml", false, (e as Error).message, "error");
    }
  } else {
    // No config is a recoverable state, not an invalid one — defaults apply.
    add("yuhi.yaml", false, "not found — run `yuhi init`", "warn");
  }

  // --- Local AI (Ollama) ---
  const ollamaPath = lookupOnPath("ollama");
  const ollamaOnPath = ollamaPath !== null;
  add(
    "Ollama binary",
    ollamaOnPath,
    ollamaOnPath ? ollamaPath! : "not found — run `yuhi setup-local-ai`",
    ollamaOnPath ? "info" : "warn",
  );

  const modelId = configuredModel(localModelSettings);
  const provider = createLocalModelProvider(providerConfigFromSettings(localModelSettings));
  // API reachable → model installed → INFERENCE smoke test (the check that catches a
  // broken model runner that 500s while /api/tags still succeeds).
  const readiness = await localModelReadiness(provider, { model: modelId });
  add(
    "Ollama API",
    readiness.apiReachable,
    readiness.apiReachable
      ? `reachable (${readiness.models.length} model(s)) — ${provider.endpoint}`
      : `not reachable — ${provider.endpoint}`,
    readiness.apiReachable ? "info" : "warn",
  );
  if (readiness.apiReachable) {
    add(
      "Model",
      readiness.modelInstalled,
      readiness.modelInstalled
        ? `${modelId} installed`
        : `${modelId} not installed — run \`yuhi setup-local-ai\``,
      readiness.modelInstalled ? "info" : "warn",
    );
  }
  if (readiness.modelInstalled) {
    add(
      "Inference",
      readiness.inference.ok,
      readiness.inference.ok
        ? "smoke test passed"
        : `failed — ${readiness.inference.reason ?? "unknown"}`,
      readiness.inference.ok ? "info" : "warn",
    );
  }

  // <cwd>/.yuhi writable
  const yuhiDir = path.join(resolvedDir, ".yuhi");
  const probe = existsSync(yuhiDir) ? yuhiDir : resolvedDir;
  let dirWritable = true;
  try {
    accessSync(probe, fsConstants.W_OK);
  } catch {
    dirWritable = false;
  }
  add(
    ".yuhi writable",
    dirWritable,
    dirWritable ? yuhiDir : `not writable: ${yuhiDir}`,
    dirWritable ? "info" : "error",
  );

  // Overall actionable local-AI state. NOTE: "Ready" requires the inference smoke
  // test to pass — never based on the API + model list alone.
  const localAi: LocalAiState = !configValid
    ? "Configuration invalid"
    : !ollamaOnPath && !readiness.apiReachable
      ? "Ollama missing"
      : !readiness.apiReachable
        ? "Ollama stopped"
        : !readiness.modelInstalled
          ? "Model missing"
          : !readiness.inference.ok
            ? "Inference failed"
            : !dirWritable
              ? "Workspace not writable"
              : "Ready";

  const issues = checks.filter((c) => !c.ok && c.severity === "error").length;
  return {
    yuhiVersion: cliVersion(),
    nodeVersion: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    checks,
    issues,
    localAi,
    ...(localAi === "Inference failed" && readiness.inference.reason
      ? { localAiReason: readiness.inference.reason }
      : {}),
  };
}

export function renderDoctor(report: DoctorReport, t: Translator): void {
  console.log(heading(t("doctor.title")));
  console.log(ui.dim(`Yuhi ${report.yuhiVersion} · Node ${report.nodeVersion} · ${report.platform}\n`));
  for (const c of report.checks) {
    const mark = c.ok ? symbols.ok() : c.severity === "error" ? symbols.err() : symbols.warn();
    const detail = c.detail ? ui.dim(`  ${c.detail}`) : "";
    console.log(`  ${mark} ${c.name}${detail}`);
  }
  const stateMark = report.localAi === "Ready" ? symbols.ok() : symbols.warn();
  console.log("\n" + `${stateMark} ${ui.bold("Local AI")}: ${report.localAi}`);
  if (report.localAi === "Inference failed") {
    if (report.localAiReason) console.log(ui.dim(`  Ollama inference failed: ${report.localAiReason}`));
    console.log(ui.dim("  Suggested actions:"));
    for (const a of INFERENCE_FAILURE_ACTIONS) console.log(ui.dim(`    - ${a}`));
    console.log(
      ui.dim("  Note: older Ollama versions can fail to run newer models — updating Ollama is a good first step."),
    );
  }
  console.log(
    "\n" + (report.issues === 0 ? symbols.ok() + " " + t("doctor.summaryOk") : symbols.warn() + " " + t("doctor.summaryIssues", { count: String(report.issues) })),
  );
}
