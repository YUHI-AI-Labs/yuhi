/**
 * MCP retrieval tests (spec §10, §20).
 *
 * The point of these tests is that the SECONDARY path cannot become a way around the
 * primary one: no MCP tool may read private bytes the gateway never exposed, exceed the
 * size bounds, skip the safety rescan, or avoid the ledger.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextRuntime, privateMetadata } from "@yuhi/context-runtime";
import { ContextStore, asObjectId, asSessionId, type ObjectId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { handleMcpMessage, MCP_PROTOCOL_VERSION } from "./server.js";
import { TOOL_DEFINITIONS, callTool, type ToolDeps } from "./tools.js";

const SESSION = asSessionId("mcp-session");
const SECRET = "-----BEGIN RSA PRIVATE KEY-----";

async function fixture(rows = 2000): Promise<{ deps: ToolDeps; objectId: ObjectId; exposed: string }> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-mcp-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-03T00:00:00.000Z" });
  const runtime = new ContextRuntime({ store, now: () => "2026-08-03T00:00:00.000Z" });

  const users = Array.from({ length: rows }, (_, i) => ({ id: i + 1, name: `user-${i}`, note: "x".repeat(40) }));
  users[900] = { id: 901, name: "admin", note: `${SECRET}MIIEowIBAAKCAQEA7Zx9qQ2vTn0lKpZs3mWf` };
  const delivery = await runtime.deliver({
    sessionId: SESSION,
    tool: "read",
    kind: "json",
    content: JSON.stringify({ users }),
    privateMetadata: privateMetadata(),
  });
  if (delivery.status !== "delivered") throw new Error("fixture delivery failed");

  return {
    deps: { store, runtime, sessionId: SESSION },
    objectId: delivery.publicMetadata.objectId,
    exposed: delivery.retrievable.find((r) => r.kind === "array-elements")?.locator ?? "",
  };
}

describe("MCP protocol surface", () => {
  it("initializes and lists exactly the retrieval tools", async () => {
    const { deps } = await fixture(100);
    const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps, "0.4.0");
    expect(init).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSION } });

    const list = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps, "0.4.0");
    const tools = (list as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toEqual([
      "yuhi_retrieve",
      "yuhi_get_lines",
      "yuhi_get_json_path",
      "yuhi_search_object",
      "yuhi_context_stats",
      "yuhi_explain_context",
    ]);
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });

  it("returns nothing for a notification and an error for an unknown method", async () => {
    const { deps } = await fixture(100);
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps, "0.4.0")).toBeUndefined();
    const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "nope" }, deps, "0.4.0");
    expect(unknown).toMatchObject({ error: { code: -32601 } });
  });
});

describe("retrieval authorization and bounds", () => {
  it("retrieves a narrower range inside an exposed omission", async () => {
    const { deps, objectId } = await fixture();
    const result = await callTool(
      "yuhi_get_json_path",
      { object_id: objectId, path: "$.users[900:905]", reason: "inspect the failing record" },
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("safety scan: passed");
    expect(result.text).toContain("user-901");
    // The secret that lived in the withheld region does not come back raw.
    expect(result.text).not.toContain(SECRET);
  });

  it("refuses a range the delivery never withheld", async () => {
    const { deps, objectId } = await fixture();
    // $.users[0] was delivered as a sample, so it is not a withheld region.
    const result = await callTool("yuhi_retrieve", { object_id: objectId, locator: "$.users[0]" }, deps);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("locator-not-withheld");
  });

  it("refuses an over-large range and suggests a narrower one", async () => {
    const { deps, objectId, exposed } = await fixture();
    const result = await callTool("yuhi_retrieve", { object_id: objectId, locator: exposed }, deps);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("range-too-large");
    expect(result.text).toContain('Try a narrower range: locator="$.users[2:');
  });

  it("refuses an object that was never delivered in this session", async () => {
    const { deps } = await fixture(100);
    const foreign = asObjectId("obj_ffffffffffffffffffffffffffffffff");
    const result = await callTool("yuhi_retrieve", { object_id: foreign, locator: "$.users[0:1]" }, deps);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("object-not-delivered-in-session");
  });

  it("rejects a malformed object id", async () => {
    const { deps } = await fixture(100);
    const result = await callTool("yuhi_retrieve", { object_id: "../../etc/passwd", locator: "$.a" }, deps);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Malformed object_id");
  });

  it("returns search positions only, never surrounding content", async () => {
    const { deps, objectId } = await fixture();
    const result = await callTool("yuhi_search_object", { object_id: objectId, query: "user-901" }, deps);
    expect(result.text).toContain("Positions only");
    expect(result.text).toMatch(/line \d+, column \d+/);
    expect(result.text).not.toContain('"note"');
  });

  it("explains a delivery: strategy, anchors, omissions and how to retrieve them", async () => {
    const { deps, objectId } = await fixture();
    const result = await callTool("yuhi_explain_context", { object_id: objectId }, deps);
    expect(result.text).toContain("Strategy: json-outline@1");
    expect(result.text).toContain("Retrievable:");
    expect(result.text).toContain("$.users[2:");
  });

  it("labels dynamic reduction as an estimate, never as a saving", async () => {
    const { deps } = await fixture(100);
    await deps.store.writeState(deps.sessionId, "gateway-stats", {
      toolResultBlocksObserved: 4,
      toolResultBlocksCompressed: 3,
      rawEstimatedTokens: 10_000,
      deliveredEstimatedTokens: 2_000,
      dynamicReduction: 0.8,
      usage: { inputTokens: 100 },
    });
    const result = await callTool("yuhi_context_stats", {}, deps);
    expect(result.text).toContain("Dynamic tool-output reduction: 80.0%");
    expect(result.text).toContain("NOT a provider or billing measurement");
    expect(result.text).not.toMatch(/cost saving|api saving/i);
  });
});
