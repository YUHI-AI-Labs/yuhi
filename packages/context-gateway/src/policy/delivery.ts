/**
 * Compact tool_result rendering (spec §8) and the honesty guard around it.
 *
 * The marker exists so the agent knows the result is a view and how to get the rest.
 * It is also pure overhead, so it is (a) short, (b) measured, and (c) skipped entirely
 * when it would not pay for itself.
 */

import type { Delivery } from "@yuhi/context-runtime";

export interface CompactRender {
  readonly text: string;
  readonly markerTokens: number;
}

type DeliveredDelivery = Extract<Delivery, { status: "delivered" }>;

export interface RenderOptions {
  readonly estimateTokens: (text: string) => number;
  /** Include a per-omission retrieve hint. Off after the first few blocks. */
  readonly withRetrieveHint: boolean;
}

export function renderCompactToolResult(delivery: DeliveredDelivery, opts: RenderOptions): CompactRender {
  const objectId = delivery.publicMetadata.objectId;
  const lines: string[] = [
    `[Yuhi dynamic context] ${delivery.strategy} · ${fmt(delivery.tokensBefore)}→${fmt(delivery.tokensAfter)} est tokens · object=${objectId} rev=${delivery.publicMetadata.revision}`,
  ];

  const preserved: string[] = [];
  if (delivery.anchors.length > 0) preserved.push(`${delivery.anchors.length} structural anchors`);
  if (delivery.secretRedactions > 0) preserved.push(`${delivery.secretRedactions} credential spans redacted`);
  if (delivery.metadataRedactions > 0) preserved.push(`${delivery.metadataRedactions} private paths masked`);
  if (preserved.length > 0) lines.push(`Preserved: ${preserved.join(" · ")}`);

  if (delivery.removed.length > 0) {
    lines.push(`Omitted: ${delivery.removed.map((r) => `${r.count} ${r.kind}`).join(" · ")}`);
  }
  if (delivery.fallback) {
    lines.push(`Note: compression unavailable — deterministic ${delivery.fallback} representation.`);
  }

  if (opts.withRetrieveHint && delivery.retrievable.length > 0) {
    const first = delivery.retrievable[0];
    lines.push(
      `Retrieve omitted context: yuhi_retrieve(object_id="${objectId}", locator="${first?.locator ?? ""}")`,
    );
  }

  const marker = `${lines.join("\n")}\n---\n`;
  return { text: `${marker}${delivery.text}`, markerTokens: opts.estimateTokens(marker) };
}

/**
 * Never make a payload bigger. If the marker plus the view is not clearly smaller than
 * the scanned original, deliver the scanned bytes and record a passthrough — §18
 * forbids claiming a reduction we did not achieve, and a bloated tool_result is a real
 * cost regression, not a rounding error.
 */
export function compactIsWorthIt(rawTokens: number, compactTokens: number, minGain = 0.05): boolean {
  if (rawTokens <= 0) return false;
  return compactTokens < rawTokens * (1 - minGain);
}

/**
 * Security failure surface. Carries public metadata only — the agent learns that
 * something exists and why it is not here, never the content.
 */
export function renderWithheldNotice(reason: string, bytes: number, kind: string): string {
  return [
    `[Yuhi dynamic context] withheld · reason=${reason} · kind=${kind} · ${bytes} bytes`,
    "Yuhi could not deliver this tool result safely, so it was not sent.",
    "The original is stored privately and was never forwarded. Ask the user to review it,",
    "or retry the operation on a narrower target.",
  ].join("\n");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
