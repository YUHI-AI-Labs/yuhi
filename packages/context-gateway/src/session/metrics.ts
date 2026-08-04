/**
 * Gateway metrics (spec §12, §15).
 *
 * Two separations are load-bearing:
 *  - Dynamic tool-output reduction (ours to claim) is never mixed with repository
 *    reduction (an estimate produced by `prepare`).
 *  - `cache_creation_input_tokens` and `cache_read_input_tokens` are recorded on their
 *    own, because a run with fewer input tokens and a busted cache costs MORE.
 */

export interface ProviderUsageObserved {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Only when the upstream actually reports it. Never modelled from a price table. */
  costUsd?: number;
}

export interface MetricsSnapshot {
  readonly sessionId: string;
  /** Which retrieval capability the agent was shown in this session. */
  readonly retrievalMode?: string;
  readonly requests: number;
  readonly toolResultBlocksObserved: number;
  readonly toolResultBlocksCompressed: number;
  readonly toolResultBlocksReused: number;
  readonly toolResultBlocksPassedThrough: number;
  readonly fallbacks: number;
  readonly withheld: number;
  readonly retrievals: number;
  readonly rawEstimatedTokens: number;
  readonly deliveredEstimatedTokens: number;
  readonly markerEstimatedTokens: number;
  readonly dynamicReduction: number;
  readonly medianCompressionLatencyMs: number;
  readonly maxCompressionLatencyMs: number;
  readonly usage: ProviderUsageObserved;
  readonly liveZoneViolations: number;
  /** Outbound appearances of a delivered secret. Detected and audited, never blocked. */
  readonly egressDetections: number;
  readonly upstreamErrors: number;
  readonly peakRssBytes: number;
}

export class GatewayMetrics {
  retrievalMode = "disabled";
  private requests = 0;
  private observed = 0;
  private compressed = 0;
  private reused = 0;
  private passedThrough = 0;
  private fallbacks = 0;
  private withheld = 0;
  private retrievals = 0;
  private rawTokens = 0;
  private deliveredTokens = 0;
  private markerTokens = 0;
  private latencies: number[] = [];
  private liveZoneViolations = 0;
  private egressDetections = 0;
  private upstreamErrors = 0;
  private peakRss = 0;
  private readonly usage: ProviderUsageObserved = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  constructor(readonly sessionId: string) {}

  request(): void {
    this.requests++;
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRss) this.peakRss = rss;
  }

  block(kind: "compressed" | "reused" | "passthrough" | "fallback" | "withheld"): void {
    this.observed++;
    if (kind === "compressed") this.compressed++;
    else if (kind === "reused") this.reused++;
    else if (kind === "passthrough") this.passedThrough++;
    else if (kind === "fallback") {
      this.fallbacks++;
      this.compressed++;
    } else this.withheld++;
  }

  tokens(raw: number, delivered: number, marker: number): void {
    this.rawTokens += raw;
    this.deliveredTokens += delivered;
    this.markerTokens += marker;
  }

  latency(ms: number): void {
    this.latencies.push(ms);
  }

  retrieval(): void {
    this.retrievals++;
  }

  liveZoneViolation(): void {
    this.liveZoneViolations++;
  }

  egressDetected(): void {
    this.egressDetections++;
  }

  upstreamError(): void {
    this.upstreamErrors++;
  }

  /** Accumulate provider-reported usage. Takes the max: streaming reports cumulatively. */
  observeUsage(usage: Partial<ProviderUsageObserved>): void {
    for (const field of ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"] as const) {
      const value = usage[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        this.usage[field] = this.usage[field] + value;
      }
    }
    if (typeof usage.costUsd === "number") {
      this.usage.costUsd = (this.usage.costUsd ?? 0) + usage.costUsd;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      sessionId: this.sessionId,
      retrievalMode: this.retrievalMode,
      requests: this.requests,
      toolResultBlocksObserved: this.observed,
      toolResultBlocksCompressed: this.compressed,
      toolResultBlocksReused: this.reused,
      toolResultBlocksPassedThrough: this.passedThrough,
      fallbacks: this.fallbacks,
      withheld: this.withheld,
      retrievals: this.retrievals,
      rawEstimatedTokens: this.rawTokens,
      deliveredEstimatedTokens: this.deliveredTokens,
      markerEstimatedTokens: this.markerTokens,
      dynamicReduction: this.rawTokens === 0 ? 0 : 1 - this.deliveredTokens / this.rawTokens,
      medianCompressionLatencyMs: median(this.latencies),
      maxCompressionLatencyMs: this.latencies.length === 0 ? 0 : Math.max(...this.latencies),
      usage: { ...this.usage },
      liveZoneViolations: this.liveZoneViolations,
      egressDetections: this.egressDetections,
      upstreamErrors: this.upstreamErrors,
      peakRssBytes: this.peakRss,
    };
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
