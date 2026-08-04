/**
 * Scan-guard and routing regression suite.
 *
 * Every test here exists because of one field failure: a plain-text `Read` of 69,168
 * estimated tokens was delivered whole and exhausted the context window. Three defects
 * lined up to produce it, and each is pinned below so none can come back quietly.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compressWithFallback, defaultCompressContext, type Compressor } from "@yuhi/context-compression";
import { asObjectId } from "@yuhi/context-store";
import { afterEach, describe, expect, it } from "vitest";

import { detectContentKind } from "./anthropic/request.js";
import { DEFAULT_SCAN_GUARD_MAX_TOKENS, isScanRead } from "./anthropic/transform.js";
import { startGateway, type GatewayHandle } from "./server.js";

const OBJECT_ID = asObjectId("obj_0123456789abcdef0123456789abcdef");
const ctx = defaultCompressContext({ now: () => "2026-08-04T00:00:00.000Z" });
const estimate = (t: string): number => Math.ceil(t.length / 4);

interface FakeUpstream {
  url: string;
  bodies: string[];
  close(): Promise<void>;
}

const open: { gateways: GatewayHandle[]; upstreams: FakeUpstream[] } = { gateways: [], upstreams: [] };

afterEach(async () => {
  for (const g of open.gateways) await g.close();
  for (const u of open.upstreams) await u.close();
  open.gateways = [];
  open.upstreams = [];
});

async function fakeUpstream(): Promise<FakeUpstream> {
  const bodies: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1 } }));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(a && typeof a === "object" ? a.port : 0);
    });
  });
  const upstream: FakeUpstream = {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  open.upstreams.push(upstream);
  return upstream;
}

async function gateway(upstream: FakeUpstream, extra: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<GatewayHandle> {
  const handle = await startGateway({
    storeRoot: join(await mkdtemp(join(tmpdir(), "yuhi-scanguard-")), "context"),
    upstreamBaseUrl: upstream.url,
    sessionOverride: "scan-guard",
    now: () => "2026-08-04T00:00:00.000Z",
    ...extra,
  });
  open.gateways.push(handle);
  return handle;
}

function readRequest(text: string, filePath = "/repo/notes.txt", id = "toolu_read"): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "Summarise it." }] },
      { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    ],
  };
}

async function post(handle: GatewayHandle, body: unknown): Promise<Response> {
  const response = await fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await response.text();
  return response;
}

function delivered(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as { messages: { content: { content?: string }[] }[] };
  return parsed.messages[parsed.messages.length - 1]?.content?.[0]?.content ?? "";
}

/** Prose with enough unique lines that duplicate-removal alone cannot compress it. */
function prose(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Paragraph ${i}: the quick brown fox jumps over lazy dog number ${i} near river ${i * 7}.`,
  ).join("\n");
}

describe("1 — .txt is prose, not source", () => {
  it("classifies .txt and .text as text so the scan guard applies to them", () => {
    expect(detectContentKind("hello", "Read", "/repo/notes.txt")).toBe("text");
    expect(detectContentKind("hello", "Read", "/repo/notes.text")).toBe("text");
    // Unchanged neighbours.
    expect(detectContentKind("x", "Read", "/repo/a.ts")).toBe("source");
    expect(detectContentKind("x", "Read", "/repo/a.log")).toBe("log");
    expect(detectContentKind('{"a":1}', "Read", "/repo/a.json")).toBe("json");
  });

  it("guards a moderate prose Read and yields above the ceiling", () => {
    const moderate = { toolName: "Read", kind: "text" as const, text: prose(200) };
    const oversized = { toolName: "Read", kind: "text" as const, text: prose(30_000) };

    expect(isScanRead(moderate, estimate)).toBe(true);
    expect(isScanRead(oversized, estimate)).toBe(false);
    // A Bash result is command output, never a scan, at any size.
    expect(isScanRead({ toolName: "Bash", kind: "text", text: moderate.text }, estimate)).toBe(false);
    expect(DEFAULT_SCAN_GUARD_MAX_TOKENS).toBe(20_000);
  });

  it("honours a configured ceiling", () => {
    const block = { toolName: "Read", kind: "text" as const, text: prose(200) };
    expect(isScanRead(block, estimate, 10)).toBe(false);
    expect(isScanRead(block, estimate, 1_000_000)).toBe(true);
  });
});

describe("2 — a weak compressor cannot shadow a strong one", () => {
  const weak: Compressor = {
    id: "weak",
    version: "1",
    supports: () => true,
    estimateTokens: estimate,
    // Removes one line out of hundreds: verifies, but is worthless.
    compress: async (input) => {
      const lines = input.content.split("\n");
      const text = lines.slice(1).join("\n");
      return {
        compressorId: "weak",
        compressorVersion: "1",
        text,
        anchors: [],
        omissions: [{ objectId: input.objectId, locator: "L1-L1", kind: "text-lines", tokensOmitted: 1, items: 1 }],
        removed: [{ kind: "text-lines", count: 1 }],
        tokensBefore: estimate(input.content),
        tokensAfter: estimate(text),
      };
    },
    verify: () => ({ ok: true }),
  };

  const strong: Compressor = {
    id: "strong",
    version: "1",
    supports: () => true,
    estimateTokens: estimate,
    compress: async (input) => ({
      compressorId: "strong",
      compressorVersion: "1",
      text: "SUMMARY",
      anchors: [],
      omissions: [{ objectId: input.objectId, locator: "L1-L999", kind: "text-lines", tokensOmitted: 999, items: 999 }],
      removed: [{ kind: "text-lines", count: 999 }],
      tokensBefore: estimate(input.content),
      tokensAfter: estimate("SUMMARY"),
    }),
    verify: () => ({ ok: true }),
  };

  it("keeps searching past a candidate that barely reduces anything", async () => {
    const outcome = await compressWithFallback(
      { objectId: OBJECT_ID, revision: 0, kind: "text", content: prose(500) },
      ctx,
      [weak, strong],
    );
    if (outcome.status !== "compressed") throw new Error("expected a compressed result");
    expect(outcome.result.compressorId).toBe("strong");
    expect(outcome.attempts[0]).toMatchObject({ compressorId: "weak", ok: false, reason: "insufficient-reduction" });
  });

  it("still returns the weak result when nothing better exists", async () => {
    const outcome = await compressWithFallback(
      { objectId: OBJECT_ID, revision: 0, kind: "text", content: prose(500) },
      ctx,
      [weak],
    );
    if (outcome.status !== "compressed") throw new Error("expected the weak fallback");
    expect(outcome.result.compressorId).toBe("weak");
  });
});

describe("5, 6, 7 — the field failure, end to end", () => {
  it("never delivers a 69k-token prose Read whole, and leaves a bounded locator", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const huge = prose(30_000);
    expect(estimate(huge)).toBeGreaterThan(69_000);

    await post(handle, readRequest(huge));
    const sent = delivered(upstream.bodies[0] ?? "");

    // 6a — the original is not delivered whole.
    expect(sent).not.toBe(huge);
    expect(estimate(sent)).toBeLessThan(estimate(huge) / 4);
    // 6b — a context-limit failure cannot come from us: what we sent is far under the window.
    expect(estimate(sent)).toBeLessThan(20_000);
    // 6c — what was withheld is retrievable.
    expect(sent).toMatch(/retrieve (L\d+-L\d+|B\d+-B\d+)/);
    // 6d — security: nothing withheld for safety, and no raw path in the delivered bytes.
    const snapshot = handle.stats().sessions[0];
    expect(snapshot?.withheld).toBe(0);
    expect(sent).not.toContain("/repo/notes.txt");
  });

  it("7 — a moderate prose Read is passed through byte-identically", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const moderate = prose(200);

    await post(handle, readRequest(moderate));
    expect(delivered(upstream.bodies[0] ?? "")).toBe(moderate);
    expect(handle.stats().sessions[0]?.toolResultBlocksPassedThrough).toBe(1);
  });

  it("3 — when nothing compresses well, the SCANNED ORIGINAL is delivered, not a wrapped weak view", async () => {
    const upstream = await fakeUpstream();
    // A compressor that "succeeds" trivially: with the envelope it is bigger than the original.
    const trivial: Compressor = {
      id: "trivial",
      version: "1",
      supports: () => true,
      estimateTokens: estimate,
      compress: async (input) => {
        const text = input.content.slice(0, input.content.length - 5);
        return {
          compressorId: "trivial",
          compressorVersion: "1",
          text,
          anchors: [],
          omissions: [],
          removed: [],
          tokensBefore: estimate(input.content),
          tokensAfter: estimate(text),
        };
      },
      verify: () => ({ ok: true }),
    };
    const handle = await gateway(upstream, { compressors: [trivial], scanGuardMaxTokens: 0 });
    const content = prose(300);

    await post(handle, readRequest(content));
    // Byte-identical to the input: not the truncated view, and no marker envelope.
    expect(delivered(upstream.bodies[0] ?? "")).toBe(content);
    expect(delivered(upstream.bodies[0] ?? "")).not.toContain("[Yuhi dynamic context]");
  });
});

describe("8 — existing routing is unchanged", () => {
  it("still routes JSON, partial JSON and test output as before", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    const json = JSON.stringify({ rows: Array.from({ length: 800 }, (_, i) => ({ i, v: "x".repeat(40) })) });
    await post(handle, readRequest(json, "/repo/data.json", "toolu_json"));
    expect(delivered(upstream.bodies[0] ?? "")).toContain("json-outline");

    const truncated = `{"rows":[${Array.from({ length: 300 }, (_, i) => `{"i":${i},"v":"${"y".repeat(50)}"}`).join(",")}`;
    await post(handle, readRequest(truncated, "/repo/partial.json", "toolu_partial"));
    expect(delivered(upstream.bodies[1] ?? "")).toContain("json-tolerant-scan");

    const testOutput = [
      "$ pnpm test",
      ...Array.from({ length: 600 }, (_, i) => ` ✓ src/mod-${i % 40}.test.ts > case ${i} 2ms`),
      "   ✗ applies the loyalty discount",
      "     AssertionError: expected 1170 to be 1080",
      "      at src/checkout/total.ts:42:11",
      "      Tests  1 failed | 600 passed (601)",
      "exit code 1",
    ].join("\n");
    await post(handle, {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "Run the tests." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pnpm test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: testOutput }] },
      ],
    });
    const testDelivered = delivered(upstream.bodies[2] ?? "");
    expect(testDelivered).toContain("test-output-failures-and-anchors");
    expect(testDelivered).toContain("exit code 1");
    expect(testDelivered).toContain("src/checkout/total.ts:42:11");
  });
});
