export * from "./context.js";
export * from "./context-id.js";
export * from "./context-manifest.js";
export * from "./init.js";
export * from "./plan.js";
export * from "./preview.js";
export * from "./workspace.js";
export * from "./audit-record.js";
export * from "./state.js";
export * from "./diff.js";
export * from "./savings.js";
export * from "./inject.js";
export * from "./route-executor.js";
export * from "./prepare-workspace.js";
export * from "./prepared-run.js";
export * from "./prepared-metrics.js";
export * from "./agent-changes.js";
export * from "./workflow-state.js";
export * from "./background-documents.js";

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
export * from "./doc-companion.js";
export * from "./stream-text.js";
export * from "./workspace-marker.js";
export * from "./document-artifact.js";
export * from "./disclosure.js";
export * from "./disclosure-config.js";
export * from "./what-ai-can-see.js";
export * from "./ai-readiness-report.js";
export * from "./repository-overview.js";
export * from "./preparation-report.js";
// Pure formatter for the v0.3.3 compression summary. Imports only the CompressionReport
// TYPE (erased at build) — never the compression engine or the TypeScript compiler — so
// it is safe to re-export here without pulling the heavy parser into every core import.
export * from "./compression-report.js";
// Safety Mode policy logic; the vocabulary it re-exports lives in @yuhi/shared, so
// @yuhi/config depends only on shared (no config↔core cycle).
export * from "./safety-mode.js";
// NOTE: compression is intentionally NOT re-exported here. It pulls in the
// TypeScript compiler (~12 MB), so it must stay opt-in / lazily imported (only
// when `yuhi prepare --compress` runs) rather than loaded for every core import.
// Consumers import it directly from "./compression/index.js".
