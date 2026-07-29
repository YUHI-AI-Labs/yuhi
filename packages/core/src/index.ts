export * from "./context.js";
export * from "./init.js";
export * from "./plan.js";
export * from "./preview.js";
export * from "./workspace.js";
export * from "./run.js";
export * from "./audit-record.js";
export * from "./state.js";
export * from "./diff.js";
export * from "./savings.js";
export * from "./inject.js";
export * from "./route-executor.js";
export * from "./prepare-workspace.js";
export * from "./prepared-metrics.js";

// Convenience re-exports so the CLI/VS Code can depend on just @yuhi/core.
export {
  listWorkspaces,
  inspectWorkspace,
  cleanWorkspace,
  cleanAllWorkspaces,
  readManifest,
} from "@yuhi/workspace";
export { listAudit, showAudit, exportAudit, writeAudit, pruneAudit } from "@yuhi/audit";
export { buildAdapter, KNOWN_AGENT_IDS, defaultEnvPassthrough } from "@yuhi/agents";
export { lookupOnPath } from "@yuhi/agents";
