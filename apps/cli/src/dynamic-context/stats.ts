/**
 * `yuhi dynamic stats` (spec §12).
 *
 * The report keeps the three measurements apart, always. Repository reduction is an
 * estimate produced by `prepare`; dynamic reduction is tool output Yuhi withheld;
 * provider usage is the only thing allowed near the word "cost" — and only when the
 * provider actually reported it.
 */

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { tallyRetrievals } from "@yuhi/context-runtime";
import type { GatewayStats, MetricsSnapshot } from "@yuhi/context-gateway";

export function formatStatsReport(stats: GatewayStats): string {
  const lines: string[] = ["Yuhi dynamic context — session report", `Upstream: ${stats.upstream}`, `Requests: ${stats.requests}`];

  if (stats.sessions.length === 0) {
    lines.push("No tool results passed through the gateway in this session.");
    return lines.join("\n");
  }

  for (const s of stats.sessions) {
    lines.push("");
    lines.push(...formatSnapshot(s));
  }
  lines.push("");
  lines.push(
    "Dynamic tool-output reduction is an estimate of the tool output Yuhi withheld before delivery.",
  );
  lines.push("It is NOT a provider token measurement, an API saving, or a billing figure.");
  return lines.join("\n");
}

export function formatSnapshot(s: MetricsSnapshot): string[] {
  const usage = s.usage;
  const usageKnown = usage.inputTokens > 0 || usage.outputTokens > 0;
  return [
    `Session ${s.sessionId}`,
    // The three measurements are printed apart, always, and an unknown is printed as
    // unknown rather than as zero.
    "  Static repository reduction: reported by `yuhi status` for the prepared run — not a session measurement",
    `  Retrieval mode: ${s.retrievalMode ?? "disabled"}`,
    `  Tool results observed: ${s.toolResultBlocksObserved}`,
    `    compressed: ${s.toolResultBlocksCompressed} · reused unchanged: ${s.toolResultBlocksReused} · passthrough: ${s.toolResultBlocksPassedThrough}`,
    `    availability fallbacks: ${s.fallbacks} · withheld for safety: ${s.withheld}`,
    `  Estimated tool-output tokens: ${s.rawEstimatedTokens.toLocaleString("en-US")} → ${s.deliveredEstimatedTokens.toLocaleString("en-US")}`,
    `  Dynamic tool-output reduction: ${(s.dynamicReduction * 100).toFixed(1)}% (marker overhead included: ${s.markerEstimatedTokens} tokens)`,
    `  Retrievals: ${s.retrievals}`,
    `  Compression latency: median ${s.medianCompressionLatencyMs.toFixed(0)} ms · max ${s.maxCompressionLatencyMs.toFixed(0)} ms`,
    `  Gateway peak RSS: ${(s.peakRssBytes / 1024 / 1024).toFixed(1)} MB · upstream errors: ${s.upstreamErrors}`,
    `  Live-zone violations (prefix bytes changed outside the live zone): ${s.liveZoneViolations}`,
    usageKnown
      ? `  Actual provider input tokens: ${usage.inputTokens}`
      : "  Actual provider input tokens: Not measured (no usage frames seen)",
    usageKnown
      ? `  Cache creation tokens: ${usage.cacheCreationInputTokens} · cache read tokens: ${usage.cacheReadInputTokens} · output tokens: ${usage.outputTokens}`
      : "  Cache creation / cache read tokens: Not measured",
    "  Provider cost change vs baseline: Not measured in a single session — run packages/context-benchmark/scripts/matrix.mts",
    usage.costUsd === undefined
      ? "  Actual cost: Not measured (provider did not report a billed cost)"
      : `  Actual cost: ${usage.costUsd} USD (provider-reported)`,
  ];
}

/**
 * Read persisted per-session snapshots from a context store root, with the retrieval
 * count taken from the LEDGER — the gateway cannot observe retrievals, which happen in
 * the MCP server's own process.
 */
export async function readPersistedStats(storeRoot: string): Promise<MetricsSnapshot[]> {
  const store = await ContextStore.open({ root: storeRoot });
  const out: MetricsSnapshot[] = [];
  for (const session of await store.listSessions()) {
    const sessionId = asSessionId(session);
    const snapshot = await store.readState<MetricsSnapshot>(sessionId, "gateway-stats");
    if (!snapshot) continue;
    const tally = await tallyRetrievals(store, sessionId);
    out.push({ ...snapshot, retrievals: tally.delivered });
  }
  return out;
}
