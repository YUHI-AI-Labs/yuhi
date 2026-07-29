import type { YuhiConfig } from "./schema.js";

/**
 * The default policy used when generating a new yuhi.yaml. Conservative by design:
 * environment/credential files are blocked, detector-driven secrets are redacted.
 */
export function defaultConfig(projectName: string): YuhiConfig {
  return {
    version: "1",
    project: { name: projectName },
    defaults: { action: "allow", agent: "claude" },
    workspace: {
      mode: "copy",
      location: "auto",
      preserve_git: false,
      include_untracked: false,
      cleanup: "prompt",
      large_file_bytes: 5_000_000,
    },
    rules: [
      {
        name: "block-environment-files",
        match: {
          paths: [
            "**/.env",
            "**/.env.*",
            "!**/.env.example",
            "!**/.env.sample",
            "**/credentials.json",
            "**/*.pem",
            "**/id_rsa",
            "**/id_ed25519",
          ],
        },
        action: "block",
        reason: "Environment and credential files must not be exposed.",
      },
      {
        name: "redact-detected-secrets",
        match: { detectors: ["api-key", "access-token", "private-key", "high-entropy-string"] },
        action: "redact",
        reason: "Detected secrets are masked in the workspace copy.",
      },
      {
        name: "block-secret-directories",
        match: { paths: ["secrets/**", "**/secrets/**", ".ssh/**", "**/.aws/**", "**/.gcp/**"] },
        action: "block",
        reason: "Directories that commonly hold credentials.",
      },
    ],
    agents: {
      claude: { command: "claude", destination: "external" },
      codex: { command: "codex", destination: "external" },
      gemini: { command: "gemini", destination: "external" },
      dummy: { command: "dummy", destination: "external" },
      local: { command: "ollama", destination: "local" },
    },
    scan: {
      keywords: [],
      entropy_threshold: 4.0,
    },
    audit: { enabled: true, store_content: false, retention_days: 30 },
    privacy: { telemetry: false },
  };
}

const SCHEMA_URL = "./.yuhi/yuhi.schema.json";

/** Render a commented yuhi.yaml file for `yuhi init`. */
export function renderConfigYaml(projectName: string): string {
  return `# yuhi.yaml — policy that decides what AI agents are allowed to see.
# Docs: https://github.com/YUHI-AI-Labs/yuhi — see README and THREAT_MODEL.
# Schema: ${SCHEMA_URL}
# yaml-language-server: $schema=${SCHEMA_URL}
version: "1"

project:
  name: ${JSON.stringify(projectName)}

defaults:
  action: allow      # default when no rule matches (secrets still escalate)
  agent: claude

workspace:
  mode: copy
  location: auto           # ~/.yuhi/workspaces/<id>
  preserve_git: false      # copying .git can expose history & remotes (see THREAT_MODEL)
  include_untracked: false
  cleanup: prompt          # prompt | always | never
  large_file_bytes: 5000000

rules:
  - name: block-environment-files
    match:
      paths:
        - "**/.env"
        - "**/.env.*"
        - "!**/.env.example"   # keep example env files (safe, useful context)
        - "!**/.env.sample"
        - "**/credentials.json"
        - "**/*.pem"
        - "**/id_rsa"
    action: block
    reason: "Environment and credential files must not be exposed."

  - name: redact-detected-secrets
    match:
      detectors:
        - api-key
        - access-token
        - private-key
        - high-entropy-string
    action: redact

  - name: block-secret-directories
    match:
      paths:
        - "secrets/**"
        - "**/secrets/**"
        - ".ssh/**"
        - "**/.aws/**"
    action: block

agents:
  claude:
    command: claude
    destination: external
  codex:
    command: codex
    destination: external
  gemini:
    command: gemini
    destination: external
  dummy:
    command: dummy
    destination: external
  local:
    command: ollama
    destination: local

scan:
  keywords: []            # extra sensitive keywords to flag
  entropy_threshold: 4.0

audit:
  enabled: true
  store_content: false    # Yuhi never stores file contents in the audit log
  retention_days: 30

privacy:
  telemetry: false

# --- Optional blocks (all safe to omit; sensible defaults apply) ---
#
# Local model used by the "Prepare locally" route. Runs on your machine only.
# local_model:
#   provider: ollama
#   endpoint: http://127.0.0.1:11434
#   model: qwen3:1.7b
#   timeout_ms: 120000
#
# Where preparation runs. "local" keeps everything on this machine.
# execution:
#   target: local          # local | managed
#   provider: ollama
#   # model: qwen3:4b
#   # region: ""
#
# How aggressively preparation may reduce context before it's sent.
# budget:
#   # max_input_tokens: 100000
#   reduction_mode: balanced   # conservative | balanced | aggressive
#   preserve: []               # kinds of content to always keep (e.g. requirements, errors)
`;
}
