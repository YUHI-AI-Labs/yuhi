/**
 * Status bar text for the isolated window.
 *
 * Six states, each one a thing the user can act on. "Measuring…" is deliberately distinct
 * from a 0% reduction: no tool output has passed through the gateway yet, which is normal
 * at the start of a session and alarming ten minutes in.
 */

import type { NativeSessionDiagnostics } from "@yuhi/context-gateway";

export type NativeStatusKind = "connecting" | "ready" | "measuring" | "reduced" | "complete" | "error";

export interface NativeStatus {
  readonly kind: NativeStatusKind;
  readonly text: string;
  readonly tooltip: string;
}

export function nativeStatus(d: NativeSessionDiagnostics | undefined, attached: boolean): NativeStatus {
  const prefix = "$(shield) Yuhi Native";
  if (!d) {
    return { kind: "connecting", text: `${prefix} · Connecting…`, tooltip: "Connecting this window to the Yuhi session." };
  }
  if (d.state === "failed" || d.state === "cleanup-failed") {
    return { kind: "error", text: `$(warning) Yuhi Native · Error`, tooltip: `Session ${d.state}. Run Yuhi: Show Native Dynamic Diagnostics.` };
  }
  if (d.state === "closed" || d.state === "closing") {
    return { kind: "complete", text: `${prefix} · Complete`, tooltip: "The session has ended and its gateway is stopped." };
  }
  if (!attached) {
    return { kind: "connecting", text: `${prefix} · Connecting…`, tooltip: "Waiting for the Yuhi session to accept this window." };
  }
  if (d.dynamicReduction === undefined) {
    const measuring = d.toolResultBlocksObserved === 0;
    return measuring
      ? { kind: "ready", text: `${prefix} · Claude ready`, tooltip: tooltipFor(d, "No tool results have passed through the gateway yet.") }
      : { kind: "measuring", text: `${prefix} · Measuring…`, tooltip: tooltipFor(d, "Tool results seen; nothing compressible yet.") };
  }
  return {
    kind: "reduced",
    text: `${prefix} · ${(d.dynamicReduction * 100).toFixed(0)}% reduced`,
    tooltip: tooltipFor(d, "Dynamic tool-output reduction for this session only."),
  };
}

function tooltipFor(d: NativeSessionDiagnostics, lead: string): string {
  return [
    lead,
    `Delivery: ${d.deliveryMode} · Retrieval: ${d.retrievalMode}`,
    `Tool results: ${d.toolResultBlocksObserved} observed · ${d.toolResultBlocksCompressed} compressed`,
    "This is an estimate of withheld tool output — not a provider token, billing, or cost measurement,",
    "and not the static repository reduction shown in Review Prepared Context.",
  ].join("\n");
}
