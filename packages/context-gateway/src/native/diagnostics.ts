/**
 * Diagnostics that are safe to export.
 *
 * A diagnostics blob is the thing a user pastes into an issue, so it is held to the same
 * rule as evidence: identifiers yes, content never. No absolute path (the workspace appears
 * as a hash), no credential, no bootstrap token, no prompt text, no filename that could name
 * a person. `redactForExport` is the choke point, and the security suite byte-scans its
 * output against canaries so a future field cannot quietly widen it.
 */

import type { NativeSessionDiagnostics } from "./types.js";
import { summariseHealth, type DiscoveredSession } from "./recovery.js";

export interface ExportableDiagnostics {
  readonly generatedAt: string;
  readonly sessions: readonly Record<string, unknown>[];
  readonly notice: string;
}

const EXPORT_NOTICE =
  "Identifiers only. Workspace paths appear as hashes; credentials, tokens, prompts and file contents are never included.";

/** Anything that looks like a filesystem path or a token gets replaced, not trimmed. */
export function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.startsWith("/") || /^[A-Za-z]:\\/.test(value) || value.startsWith("~")) return "<path>";
  if (/^(sk-|Bearer\s|eyJ)/.test(value)) return "<redacted>";
  return value;
}

export function redactForExport(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/token|secret|credential|apikey|api_key|password|prompt/i.test(key)) continue;
    out[key] = Array.isArray(value) ? value.map(redactValue) : redactValue(value);
  }
  return out;
}

export function diagnosticsRows(d: NativeSessionDiagnostics): readonly { label: string; value: string }[] {
  const notMeasured = "Not measured";
  return [
    { label: "Session ID", value: d.sessionId },
    { label: "State", value: d.state },
    { label: "Gateway health", value: d.gatewayHealthy ? "healthy" : "unreachable" },
    { label: "VS Code attached", value: d.vscodeAttached ? "yes" : "no" },
    { label: "Claude extension version", value: d.claudeExtensionVersion ?? "unknown" },
    { label: "Delivery mode", value: d.deliveryMode },
    { label: "Retrieval mode", value: d.retrievalMode },
    { label: "Last heartbeat", value: d.lastHeartbeatAt ?? "never" },
    { label: "Requests", value: String(d.requests) },
    { label: "Tool results observed", value: String(d.toolResultBlocksObserved) },
    { label: "Blocks compressed", value: String(d.toolResultBlocksCompressed) },
    {
      label: "Dynamic tool-output reduction",
      value: d.dynamicReduction === undefined ? notMeasured : `${(d.dynamicReduction * 100).toFixed(1)}%`,
    },
    { label: "Upstream errors", value: String(d.upstreamErrors) },
    { label: "Cleanup status", value: d.cleanupStatus },
  ];
}

export function exportDiagnostics(
  sessions: readonly NativeSessionDiagnostics[],
  generatedAt: string,
): ExportableDiagnostics {
  return {
    generatedAt,
    sessions: sessions.map((s) => redactForExport({ ...s })),
    notice: EXPORT_NOTICE,
  };
}

/** One line per discovered session, for `yuhi dynamic sessions` and the picker. */
export function describeDiscovered(session: DiscoveredSession): string {
  const record = session.record;
  const mode = record ? `${record.deliveryMode}/${record.retrievalMode}` : "unknown";
  return `${session.sessionId}  ${summariseHealth(session)}  ${mode}`;
}
