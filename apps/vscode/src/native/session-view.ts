/**
 * The panel section for a Native GUI session.
 *
 * Static repository reduction never appears here, and an unknown prints "Not measured"
 * rather than 0 — a zero reads as a measured result, which is exactly the misreading
 * V0_4_0_RELEASE_SCOPE.md §4 prohibits.
 */

import type { DynamicContextStats, NativeSessionDiagnostics } from "@yuhi/context-gateway";

export interface NativeSessionRow {
  readonly label: string;
  readonly value: string;
}

export interface NativeSessionPanelView {
  readonly title: "Native Claude GUI Session";
  readonly rows: readonly NativeSessionRow[];
  readonly footnote: string;
}

const NOT_MEASURED = "Not measured";

export function nativeSessionPanelView(
  d: NativeSessionDiagnostics | undefined,
  stats: DynamicContextStats | undefined,
): NativeSessionPanelView {
  const snapshot = stats?.sessions[0];
  const usage = snapshot?.usage;
  const usageKnown = usage !== undefined && (usage.inputTokens > 0 || usage.cacheCreationInputTokens > 0);
  const n = (v: number | undefined): string => (v === undefined ? NOT_MEASURED : v.toLocaleString("en-US"));

  return {
    title: "Native Claude GUI Session",
    rows: [
      { label: "Status", value: d?.state ?? NOT_MEASURED },
      { label: "Delivery Mode", value: d?.deliveryMode ?? NOT_MEASURED },
      { label: "Retrieval Mode", value: d?.retrievalMode ?? NOT_MEASURED },
      { label: "Claude extension version", value: d?.claudeExtensionVersion ?? "unknown" },
      { label: "Gateway health", value: d === undefined ? NOT_MEASURED : d.gatewayHealthy ? "healthy" : "unreachable" },
      { label: "Requests", value: n(d?.requests) },
      { label: "Tool results observed", value: n(snapshot?.toolResultBlocksObserved ?? d?.toolResultBlocksObserved) },
      { label: "Blocks compressed", value: n(snapshot?.toolResultBlocksCompressed ?? d?.toolResultBlocksCompressed) },
      {
        label: "Dynamic tool-output reduction",
        value: d?.dynamicReduction === undefined ? NOT_MEASURED : `${(d.dynamicReduction * 100).toFixed(1)}%`,
      },
      { label: "Provider input tokens", value: usageKnown ? n(usage.inputTokens) : NOT_MEASURED },
      { label: "Cache creation tokens", value: usageKnown ? n(usage.cacheCreationInputTokens) : NOT_MEASURED },
      { label: "Cache read tokens", value: usageKnown ? n(usage.cacheReadInputTokens) : NOT_MEASURED },
      { label: "Provider-reported cost", value: usage?.costUsd === undefined ? NOT_MEASURED : `${usage.costUsd} USD` },
      // From the ledger via diagnostics; the gateway's own counter cannot see the MCP process.
      { label: "Retrievals", value: d === undefined ? NOT_MEASURED : String(d.retrievalsDelivered) },
      { label: "Fallbacks", value: n(snapshot?.fallbacks) },
      { label: "Security detections", value: n(snapshot?.withheld) },
      { label: "Egress detections", value: n(snapshot?.egressDetections) },
    ],
    footnote:
      "This session only. Dynamic tool-output reduction is an estimate of withheld tool output; it is separate from the static repository reduction and is not a provider token, billing, or cost measurement.",
  };
}
