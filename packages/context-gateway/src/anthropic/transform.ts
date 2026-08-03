/**
 * Request-side live-zone transformation (spec §5, §7).
 *
 * Order is fixed and no block bypasses it:
 *   raw tool_result → private store → content type → secret/PII/metadata scan →
 *   compression → anchor verification → exact-output rescan → token estimate →
 *   prefix-stability check → compact tool_result → evidence → upstream.
 *
 * The runtime owns the middle of that chain; this module owns the live-zone decision
 * (what is new), the compact rendering, and the proof that nothing outside the live
 * zone changed.
 */

import type { ObjectId, SessionId } from "@yuhi/context-store";
import type { ContextRuntime, ToolName } from "@yuhi/context-runtime";

import type { GatewayMetrics } from "../session/metrics.js";
import type { PrefixState } from "../session/prefix-state.js";
import { compactIsWorthIt, renderCompactToolResult, renderWithheldNotice } from "../policy/delivery.js";
import {
  applyToolResultText,
  changedPaths,
  collectToolResults,
  deriveSessionId,
  isToolResultContentPath,
  type AnthropicRequest,
  type ToolResultRef,
} from "./request.js";

export interface TransformDeps {
  readonly runtime: ContextRuntime;
  readonly prefixFor: (sessionId: SessionId) => Promise<PrefixState>;
  readonly metricsFor: (sessionId: SessionId) => GatewayMetrics;
  /** Above this request size the structural live-zone proof is skipped (cost guard). */
  readonly verifyLiveZoneMaxBytes?: number;
  /** How many blocks per session carry a retrieve hint before it becomes noise. */
  readonly hintRetrieveForFirstBlocks?: number;
}

export interface TransformOutcome {
  readonly body: Buffer;
  readonly sessionId: SessionId;
  readonly transformed: number;
  readonly reused: number;
  readonly withheld: number;
  readonly liveZoneViolations: readonly string[];
  readonly passthrough: boolean;
}

export async function transformRequest(
  raw: Buffer,
  deps: TransformDeps,
  sessionOverride?: string,
): Promise<TransformOutcome> {
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw.toString("utf8")) as AnthropicRequest;
  } catch {
    // Not a JSON body we understand: forward the exact bytes. Yuhi never mangles a
    // request it cannot parse.
    return {
      body: raw,
      sessionId: deriveSessionId({}, sessionOverride),
      transformed: 0,
      reused: 0,
      withheld: 0,
      liveZoneViolations: [],
      passthrough: true,
    };
  }

  const sessionId = deriveSessionId(body, sessionOverride);
  const metrics = deps.metricsFor(sessionId);
  const prefix = await deps.prefixFor(sessionId);
  const refs = collectToolResults(body);
  if (refs.length === 0) {
    return {
      body: raw,
      sessionId,
      transformed: 0,
      reused: 0,
      withheld: 0,
      liveZoneViolations: [],
      passthrough: true,
    };
  }

  const verifyLimit = deps.verifyLiveZoneMaxBytes ?? 4 * 1024 * 1024;
  const original = raw.byteLength <= verifyLimit ? (JSON.parse(raw.toString("utf8")) as AnthropicRequest) : undefined;
  const hintLimit = deps.hintRetrieveForFirstBlocks ?? 3;

  let transformed = 0;
  let reused = 0;
  let withheld = 0;
  let hinted = 0;

  for (const ref of refs) {
    // 1. Live zone: an unchanged block that was already delivered must be re-emitted
    //    with the SAME bytes, so the provider's cached prefix stays valid.
    const known = await prefix.lookup(ref.toolUseId, ref.rawHash);
    if (known) {
      applyToolResultText(body, ref, known.text);
      metrics.block("reused");
      reused++;
      continue;
    }

    const started = performance.now();
    const delivery = await deps.runtime.deliver({
      sessionId,
      tool: toolNameFor(ref),
      kind: ref.kind,
      content: ref.text,
      privateMetadata: ref.privateMetadata,
      toolUseId: ref.toolUseId,
    });
    metrics.latency(performance.now() - started);

    if (delivery.status === "withheld") {
      // Security failure: a notice, never the content.
      const notice = renderWithheldNotice(delivery.reason, delivery.publicMetadata.bytes, delivery.publicMetadata.kind);
      applyToolResultText(body, ref, notice);
      await remember(
        prefix,
        ref,
        notice,
        `withheld:${delivery.reason}`,
        deps,
        deps.runtime.estimateTokens(ref.text),
        delivery.publicMetadata.objectId,
      );
      metrics.block("withheld");
      metrics.tokens(deps.runtime.estimateTokens(ref.text), deps.runtime.estimateTokens(notice), 0);
      withheld++;
      continue;
    }

    const rendered = renderCompactToolResult(delivery, {
      estimateTokens: (t) => deps.runtime.estimateTokens(t),
      withRetrieveHint: delivery.retrievable.length > 0 && hinted < hintLimit,
    });
    const compactTokens = delivery.tokensAfter + rendered.markerTokens;

    // 2. Honesty guard: if the marker would make the payload no smaller, send the
    //    scanned bytes without a marker and record a passthrough.
    let finalText: string;
    let strategy: string;
    let markerTokens = 0;
    if (compactIsWorthIt(delivery.tokensBefore, compactTokens)) {
      finalText = rendered.text;
      strategy = delivery.strategy;
      markerTokens = rendered.markerTokens;
      if (delivery.retrievable.length > 0) hinted++;
      metrics.block(delivery.fallback ? "fallback" : "compressed");
      transformed++;
    } else {
      finalText = delivery.text;
      strategy = "passthrough-scanned";
      metrics.block("passthrough");
    }

    applyToolResultText(body, ref, finalText);
    metrics.tokens(delivery.tokensBefore, deps.runtime.estimateTokens(finalText), markerTokens);
    await remember(prefix, ref, finalText, strategy, deps, delivery.tokensBefore, delivery.publicMetadata.objectId);
  }

  // 3. Prove the live zone: every changed path must be tool_result content. A violation
  //    means we touched cacheable prefix — we discard the transform rather than ship it.
  let violations: string[] = [];
  if (original) {
    violations = changedPaths(original, body).filter((p) => !isToolResultContentPath(p));
    if (violations.length > 0) {
      metrics.liveZoneViolation();
      return {
        body: raw,
        sessionId,
        transformed: 0,
        reused: 0,
        withheld: 0,
        liveZoneViolations: violations,
        passthrough: true,
      };
    }
  }

  return {
    body: Buffer.from(JSON.stringify(body), "utf8"),
    sessionId,
    transformed,
    reused,
    withheld,
    liveZoneViolations: violations,
    passthrough: false,
  };
}

async function remember(
  prefix: PrefixState,
  ref: ToolResultRef,
  text: string,
  strategy: string,
  deps: TransformDeps,
  tokensBefore: number,
  rawObjectId: ObjectId,
): Promise<void> {
  // The runtime already stored the raw bytes; reuse its object id rather than writing
  // the same content twice.
  await prefix.remember({
    toolUseId: ref.toolUseId,
    rawHash: ref.rawHash,
    rawObjectId,
    text,
    strategy,
    tokensBefore,
    tokensAfter: deps.runtime.estimateTokens(text),
  });
}

function toolNameFor(ref: ToolResultRef): ToolName {
  const name = (ref.toolName ?? "").toLowerCase();
  if (name === "read") return "read";
  if (name === "grep") return "grep";
  if (name === "glob") return "glob";
  if (name === "bash" || name === "shell") return ref.kind === "test-output" ? "test" : "bash";
  if (name.startsWith("mcp__")) return "mcp";
  if (ref.kind === "test-output") return "test";
  return "search";
}
