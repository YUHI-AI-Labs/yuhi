/**
 * Upstream forwarding and usage capture (spec §13, §15).
 *
 * The response is STREAMED, never buffered: SSE event order, responsiveness, usage
 * events, error propagation and cancellation all have to survive the hop. Usage is
 * extracted by teeing the chunks into a small bounded scanner, so measurement never
 * delays a byte.
 *
 * Credentials pass through and are never logged, recorded, or stored (THREAT_MODEL T7).
 */

import type { ServerResponse } from "node:http";

import type { ProviderUsageObserved } from "../session/metrics.js";

/** Hop-by-hop and length headers we must not copy verbatim. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "accept-encoding",
  "proxy-connection",
]);

const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ForwardInput {
  readonly upstreamBaseUrl: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: Buffer;
  readonly signal: AbortSignal;
  readonly fetchImpl?: FetchLike;
}

export async function forwardRequest(input: ForwardInput): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  // Identity encoding keeps SSE frames intact for the usage scanner without buffering.
  headers.set("accept-encoding", "identity");

  const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchLike);
  return doFetch(`${input.upstreamBaseUrl.replace(/\/$/, "")}${input.path}`, {
    method: input.method,
    headers,
    ...(input.body ? { body: input.body } : {}),
    signal: input.signal,
    redirect: "manual",
  });
}

export function copyResponseHeaders(response: Response, res: ServerResponse): void {
  response.headers.forEach((value, key) => {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
}

/** Bounded window kept for usage scanning. Usage frames are small and near the ends. */
const USAGE_WINDOW_BYTES = 64 * 1024;
/** Carried between chunks so a secret split across a frame boundary is still detected. */
const EGRESS_OVERLAP_CHARS = 256;

/**
 * Stream the upstream response to the client, teeing chunks into a bounded buffer so
 * provider usage can be read without holding the response.
 */
export async function pipeWithUsageCapture(
  response: Response,
  res: ServerResponse,
  onUsage: (usage: Partial<ProviderUsageObserved>) => void,
  /** Called with each decoded chunk (plus a small overlap) for egress inspection. */
  onText?: (text: string) => void,
): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let window = "";
  // Usage frames are CUMULATIVE within one response (message_start then message_delta),
  // so the last frame is reported once at the end. Reporting per chunk would multiply
  // the same tokens by the number of chunks and inflate the measurement.
  let latest: Partial<ProviderUsageObserved> | undefined;
  let overlap = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Write first: measurement must never add latency to the agent's stream.
      const flushed = res.write(Buffer.from(value));
      if (!flushed) await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      const chunkText = Buffer.from(value).toString("utf8");
      // Overlap so a value split across two chunks is still recognisable.
      if (onText) onText(`${overlap}${chunkText}`);
      overlap = chunkText.slice(-EGRESS_OVERLAP_CHARS);
      window = `${window}${chunkText}`.slice(-USAGE_WINDOW_BYTES);
      const usage = extractUsage(window);
      if (usage) latest = { ...latest, ...usage };
    }
  } finally {
    if (latest) onUsage(latest);
    res.end();
  }
}

/**
 * Extract the LAST complete `"usage": {...}` object in the window. Anthropic reports
 * usage on `message_start` and cumulatively on `message_delta`, so the last one wins.
 */
export function extractUsage(text: string): Partial<ProviderUsageObserved> | undefined {
  let found: Partial<ProviderUsageObserved> | undefined;
  const re = /"usage"\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const body = readBalancedObject(text, open);
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const usage: Partial<ProviderUsageObserved> = {};
      assignNumber(parsed, "input_tokens", (v) => (usage.inputTokens = v));
      assignNumber(parsed, "output_tokens", (v) => (usage.outputTokens = v));
      assignNumber(parsed, "cache_creation_input_tokens", (v) => (usage.cacheCreationInputTokens = v));
      assignNumber(parsed, "cache_read_input_tokens", (v) => (usage.cacheReadInputTokens = v));
      if (Object.keys(usage).length > 0) found = usage;
    } catch {
      // A partial frame at the window edge; the next chunk completes it.
    }
  }
  return found;
}

function assignNumber(source: Record<string, unknown>, key: string, set: (value: number) => void): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) set(value);
}

function readBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
