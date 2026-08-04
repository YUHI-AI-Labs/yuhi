/**
 * Rendering diagnostics for humans, and for pasting into an issue.
 *
 * The export path goes through `exportDiagnostics`, which redacts paths and anything
 * token-shaped. Nothing here formats a raw value that the redactor has not already seen.
 */

import { diagnosticsRows, exportDiagnostics, type NativeSessionDiagnostics } from "@yuhi/context-gateway";

export function renderDiagnostics(sessions: readonly NativeSessionDiagnostics[]): string {
  if (sessions.length === 0) return "No Native GUI sessions are running.";
  return sessions
    .map((d) => ["Native Claude GUI Session", ...diagnosticsRows(d).map((r) => `  ${r.label}: ${r.value}`)].join("\n"))
    .join("\n\n");
}

export function renderExport(sessions: readonly NativeSessionDiagnostics[], generatedAt: string): string {
  return `${JSON.stringify(exportDiagnostics(sessions, generatedAt), null, 2)}\n`;
}
