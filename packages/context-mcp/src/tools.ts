/**
 * MCP retrieval tools (spec §2 secondary path, §10).
 *
 * This is the SECONDARY path: it exists so the agent can pull back a region Yuhi
 * withheld, explain a delivery, or read statistics. Compression does NOT depend on it —
 * a session where the agent never calls an MCP tool is still fully compressed by the
 * gateway.
 *
 * Every tool goes through `ContextRuntime`, so none of them can bypass authorization,
 * the size bounds, the safety rescan, or the evidence ledger (§20).
 */

import { asObjectId, type ContextStore, type ObjectId, type SessionId } from "@yuhi/context-store";
import type { ContextRuntime } from "@yuhi/context-runtime";

export interface ToolDeps {
  readonly store: ContextStore;
  readonly runtime: ContextRuntime;
  readonly sessionId: SessionId;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "yuhi_retrieve",
    description:
      "Retrieve a region of a tool result that Yuhi withheld. Use the object_id and locator printed in the [Yuhi dynamic context] header. Bounded and safety-scanned.",
    inputSchema: {
      type: "object",
      properties: {
        object_id: { type: "string", description: "Opaque Yuhi object id (obj_…)" },
        locator: { type: "string", description: "Exposed locator, e.g. $.users[2:1998] or L61-L360" },
        reason: { type: "string", description: "Why this range is needed (recorded in the evidence ledger)" },
      },
      required: ["object_id", "locator"],
    },
  },
  {
    name: "yuhi_get_lines",
    description: "Retrieve a bounded line range from a stored tool result.",
    inputSchema: {
      type: "object",
      properties: {
        object_id: { type: "string" },
        from: { type: "integer", description: "1-indexed first line" },
        to: { type: "integer", description: "1-indexed last line (inclusive)" },
        reason: { type: "string" },
      },
      required: ["object_id", "from", "to"],
    },
  },
  {
    name: "yuhi_get_json_path",
    description: "Retrieve a JSONPath region from a stored JSON tool result. Subset: $.key, [n], [*], [a:b].",
    inputSchema: {
      type: "object",
      properties: {
        object_id: { type: "string" },
        path: { type: "string", description: "e.g. $.users[8214]" },
        reason: { type: "string" },
      },
      required: ["object_id", "path"],
    },
  },
  {
    name: "yuhi_search_object",
    description:
      "Find where a literal string occurs in a stored tool result. Returns positions only — never surrounding content.",
    inputSchema: {
      type: "object",
      properties: {
        object_id: { type: "string" },
        query: { type: "string" },
        max_matches: { type: "integer" },
      },
      required: ["object_id", "query"],
    },
  },
  {
    name: "yuhi_context_stats",
    description: "Dynamic context statistics for this session: reduction, retrievals, fallbacks, provider usage.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "yuhi_explain_context",
    description:
      "Explain what Yuhi did to a delivered tool result: strategy, anchors preserved, regions omitted, and how to retrieve them.",
    inputSchema: {
      type: "object",
      properties: { object_id: { type: "string" } },
    },
  },
];

export interface ToolOutcome {
  readonly text: string;
  readonly isError?: boolean;
}

export async function callTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> {
  switch (name) {
    case "yuhi_retrieve":
      return retrieve(deps, str(args["object_id"]), str(args["locator"]), optionalStr(args["reason"]));
    case "yuhi_get_lines": {
      const from = int(args["from"]);
      const to = int(args["to"]);
      if (from === undefined || to === undefined) return { text: "from and to must be integers", isError: true };
      return retrieve(deps, str(args["object_id"]), `L${from}-L${to}`, optionalStr(args["reason"]));
    }
    case "yuhi_get_json_path":
      return retrieve(deps, str(args["object_id"]), str(args["path"]), optionalStr(args["reason"]));
    case "yuhi_search_object":
      return search(deps, str(args["object_id"]), str(args["query"]), int(args["max_matches"]));
    case "yuhi_context_stats":
      return stats(deps);
    case "yuhi_explain_context":
      return explain(deps, optionalStr(args["object_id"]));
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}

async function retrieve(deps: ToolDeps, objectIdRaw: string, locator: string, reason?: string): Promise<ToolOutcome> {
  const objectId = parseObjectId(objectIdRaw);
  if (!objectId) return { text: "Malformed object_id", isError: true };

  const result = await deps.runtime.retrieveByObject({
    sessionId: deps.sessionId,
    objectId,
    locator,
    ...(reason ? { reason } : {}),
  });

  if (result.status === "withheld") {
    const hint = result.suggestion ? `\nTry a narrower range: locator="${result.suggestion}"` : "";
    return {
      text: `[Yuhi retrieval] withheld · reason=${result.reason} · locator=${result.locator}${hint}`,
      isError: true,
    };
  }
  return {
    text: [
      `[Yuhi retrieval] object=${objectId} locator=${result.locator} · ${result.tokens} est tokens · safety scan: passed`,
      "---",
      result.text,
    ].join("\n"),
  };
}

async function search(
  deps: ToolDeps,
  objectIdRaw: string,
  query: string,
  maxMatches: number | undefined,
): Promise<ToolOutcome> {
  const objectId = parseObjectId(objectIdRaw);
  if (!objectId) return { text: "Malformed object_id", isError: true };
  // Authorization: the object must have been delivered in THIS session.
  const deliveries = await deps.runtime.deliveriesForObject(deps.sessionId, objectId);
  if (deliveries.length === 0) {
    return { text: "[Yuhi search] withheld · reason=object-not-delivered-in-session", isError: true };
  }
  const matches = await deps.store.search(deps.sessionId, objectId, query, {
    ...(maxMatches === undefined ? {} : { maxMatches }),
  });
  const lines = matches.slice(0, 50).map((m) => `line ${m.line}, column ${m.column}`);
  return {
    text: [
      `[Yuhi search] object=${objectId} query matched ${matches.length} time(s). Positions only.`,
      ...lines,
      matches.length > 0
        ? `Retrieve around a hit: yuhi_get_lines(object_id="${objectId}", from=${Math.max(1, (matches[0]?.line ?? 1) - 5)}, to=${(matches[0]?.line ?? 1) + 5})`
        : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

async function stats(deps: ToolDeps): Promise<ToolOutcome> {
  const snapshot = await deps.store.readState<Record<string, unknown>>(deps.sessionId, "gateway-stats");
  if (!snapshot) return { text: "[Yuhi stats] no dynamic-context activity recorded for this session yet." };
  const reduction = typeof snapshot["dynamicReduction"] === "number" ? snapshot["dynamicReduction"] : 0;
  return {
    text: [
      "[Yuhi dynamic context stats]",
      `Tool results observed: ${snapshot["toolResultBlocksObserved"] ?? 0}`,
      `Compressed: ${snapshot["toolResultBlocksCompressed"] ?? 0} · reused unchanged: ${snapshot["toolResultBlocksReused"] ?? 0} · passthrough: ${snapshot["toolResultBlocksPassedThrough"] ?? 0}`,
      `Fallbacks: ${snapshot["fallbacks"] ?? 0} · withheld: ${snapshot["withheld"] ?? 0}`,
      `Estimated tool-output tokens: ${snapshot["rawEstimatedTokens"] ?? 0} → ${snapshot["deliveredEstimatedTokens"] ?? 0}`,
      `Dynamic tool-output reduction: ${(reduction * 100).toFixed(1)}% (an estimate of tool output, NOT a provider or billing measurement)`,
      `Provider usage observed: ${JSON.stringify(snapshot["usage"] ?? {})}`,
    ].join("\n"),
  };
}

async function explain(deps: ToolDeps, objectIdRaw?: string): Promise<ToolOutcome> {
  if (!objectIdRaw) {
    return { text: "Pass the object_id from a [Yuhi dynamic context] header to explain that delivery." };
  }
  const objectId = parseObjectId(objectIdRaw);
  if (!objectId) return { text: "Malformed object_id", isError: true };
  const deliveries = await deps.runtime.deliveriesForObject(deps.sessionId, objectId);
  if (deliveries.length === 0) {
    return { text: "[Yuhi explain] no delivery recorded for that object in this session.", isError: true };
  }
  const latest = deliveries[deliveries.length - 1];
  if (!latest) return { text: "[Yuhi explain] unavailable", isError: true };
  return {
    text: [
      `[Yuhi explain] object=${objectId}`,
      `Strategy: ${latest.strategy} · path: ${latest.deliveryPath}`,
      `Tokens: ${latest.tokensBefore} → ${latest.tokensAfter}`,
      `Anchors preserved: ${latest.anchors.length}`,
      `Credential spans redacted: ${latest.secretRedactions} · private paths masked: ${latest.metadataRedactions}`,
      latest.removed.length > 0 ? `Removed: ${latest.removed.map((r) => `${r.count} ${r.kind}`).join(", ")}` : "Removed: nothing",
      latest.omissions.length > 0
        ? `Retrievable:\n${latest.omissions.map((o) => `  ${o.locator} (${o.kind}${o.items === undefined ? "" : `, ${o.items} items`}, ~${o.tokensOmitted} tokens)`).join("\n")}`
        : "Retrievable: nothing was withheld",
    ].join("\n"),
  };
}

function parseObjectId(raw: string): ObjectId | undefined {
  try {
    return asObjectId(raw.trim());
  } catch {
    return undefined;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
