/**
 * Gateway acceptance tests (spec §5 required tests, §13, §17).
 *
 * These run a REAL loopback HTTP upstream, so streaming, header handling, usage frames
 * and cancellation are exercised rather than mocked.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { changedPaths, detectContentKind, deriveSessionId, isToolResultContentPath } from "./anthropic/request.js";
import { extractUsage } from "./anthropic/upstream.js";
import { startGateway, type GatewayHandle } from "./server.js";

const SECRET = "-----BEGIN RSA PRIVATE KEY-----";
const ABSOLUTE_PATH = "/Users/testuser/private-project/data.json";

interface FakeUpstream {
  readonly url: string;
  readonly bodies: string[];
  readonly paths: string[];
  close(): Promise<void>;
}

async function startFakeUpstream(opts: { sse?: boolean } = {}): Promise<FakeUpstream> {
  const bodies: string[] = [];
  const paths: string[] = [];
  const server: Server = createServer(async (req, res) => {
    paths.push(req.url ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));

    if (opts.sse) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const usage = { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 900, output_tokens: 5 };
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "ok" } })}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
      }),
    );
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const open: { gateways: GatewayHandle[]; upstreams: FakeUpstream[] } = { gateways: [], upstreams: [] };

afterEach(async () => {
  for (const g of open.gateways) await g.close();
  for (const u of open.upstreams) await u.close();
  open.gateways = [];
  open.upstreams = [];
});

async function gateway(upstream: FakeUpstream, extra: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<GatewayHandle> {
  const root = extra.storeRoot ?? join(await mkdtemp(join(tmpdir(), "yuhi-gw-")), "context");
  const handle = await startGateway({
    storeRoot: root,
    upstreamBaseUrl: upstream.url,
    sessionOverride: "gw-test-session",
    now: () => "2026-08-03T00:00:00.000Z",
    ...extra,
  });
  open.gateways.push(handle);
  return handle;
}

async function fakeUpstream(opts: { sse?: boolean } = {}): Promise<FakeUpstream> {
  const upstream = await startFakeUpstream(opts);
  open.upstreams.push(upstream);
  return upstream;
}

function largeJson(rows = 2000): string {
  const users = Array.from({ length: rows }, (_, i) => ({
    id: i + 1,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    note: "x".repeat(120),
  }));
  users[0] = { id: 1, name: "admin", email: "admin@example.com", note: `${SECRET}MIIEowIBAAKCAQEA7Zx9qQ2vTn0lKpZs3mWfYbGh` };
  return JSON.stringify({ configPath: ABSOLUTE_PATH, users });
}

function testRunOutput(passing = 600): string {
  const lines: string[] = ["$ vitest run", "", " RUN  v2.1.9 /repo"];
  for (let i = 0; i < passing; i++) {
    lines.push(` ✓ src/mod-${i % 40}.test.ts > case ${i} ${1 + (i % 9)}ms`);
    if (i % 60 === 0) lines.push("npm warn deprecated inflight@1.0.6: unmaintained");
  }
  lines.push(
    "   ✗ applies the loyalty discount",
    "     AssertionError: expected 1170 to be 1080",
    "      at src/checkout/total.ts:42:11",
    " Test Files  1 failed | 40 passed (41)",
    `      Tests  1 failed | ${passing} passed (${passing + 1})`,
    "exit code 1",
  );
  return lines.join("\n");
}

function grepOutput(files = 40, hits = 10): string {
  const lines: string[] = [];
  for (let f = 0; f < files; f++) {
    for (let h = 0; h < hits; h++) lines.push(`src/module-${f}/handler.ts:${100 + h}:  computeTotal(order)`);
  }
  return lines.join("\n");
}

/** A realistic Claude Code turn: user text, tool_use, tool_result. */
function messagesRequest(results: { id: string; text: string }[], stream = false): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    max_tokens: 4096,
    // Unknown-to-Yuhi fields that MUST survive untouched.
    thinking: { type: "enabled", budget_tokens: 2048 },
    output_config: { style: "concise" },
    system: [{ type: "text", text: "You are a careful engineer.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
    metadata: { user_id: "u1" },
    stream,
    messages: [
      { role: "user", content: [{ type: "text", text: "Investigate the payload." }] },
      {
        role: "assistant",
        content: results.map((r) => ({
          type: "tool_use",
          id: r.id,
          name: "Read",
          input: { file_path: ABSOLUTE_PATH },
        })),
      },
      { role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text })) },
    ],
  };
}

async function post(handle: GatewayHandle, body: unknown, path = "/v1/messages"): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key-never-logged", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

function toolResultContent(bodyText: string, blockIndex = 0): string {
  const parsed = JSON.parse(bodyText) as { messages: { content: { content?: string }[] }[] };
  const last = parsed.messages[parsed.messages.length - 1];
  return last?.content?.[blockIndex]?.content ?? "";
}

describe("live-zone interception", () => {
  it("compresses a new tool_result and forwards a compact, safe payload upstream", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    const response = await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson() }]));
    expect(response.status).toBe(200);

    const sent = upstream.bodies[0] ?? "";
    const delivered = toolResultContent(sent);
    expect(delivered).toContain("[Yuhi dynamic context]");
    expect(delivered).toContain("array(2000)");
    // §17 zeros, measured on the bytes that actually left the machine. Note the scope:
    // the agent's OWN tool_use input still carries the path it chose to read — that is
    // prefix Yuhi must not rewrite. The boundary applies to what Yuhi DELIVERS.
    expect(sent).not.toContain(SECRET);
    expect(delivered).not.toContain(ABSOLUTE_PATH);
    expect(delivered).not.toContain("testuser");

    const snapshot = handle.stats().sessions[0];
    expect(snapshot?.toolResultBlocksCompressed).toBe(1);
    // §17: ≥70% reduction on large JSON.
    expect(snapshot ? 1 - snapshot.deliveredEstimatedTokens / snapshot.rawEstimatedTokens : 0).toBeGreaterThan(0.7);
  });

  it("never rewrites anything outside the tool_result content", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const request = messagesRequest([{ id: "toolu_1", text: largeJson(300) }]);

    await post(handle, request);
    const sent = JSON.parse(upstream.bodies[0] ?? "{}") as Record<string, unknown>;

    // Everything Yuhi does not own must be byte-for-byte the same object graph.
    expect(sent["system"]).toEqual(request["system"]);
    expect(sent["tools"]).toEqual(request["tools"]);
    expect(sent["thinking"]).toEqual(request["thinking"]);
    expect(sent["output_config"]).toEqual(request["output_config"]);
    expect(sent["metadata"]).toEqual(request["metadata"]);
    expect(sent["max_tokens"]).toBe(request["max_tokens"]);

    const diffs = changedPaths(request, sent);
    expect(diffs.every((p) => isToolResultContentPath(p))).toBe(true);
    expect(handle.stats().sessions[0]?.liveZoneViolations).toBe(0);
  });

  it("re-sends an unchanged block with byte-identical bytes", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const request = messagesRequest([{ id: "toolu_1", text: largeJson() }]);

    await post(handle, request);
    await post(handle, request);

    expect(upstream.bodies[1]).toBe(upstream.bodies[0]);
    const snapshot = handle.stats().sessions[0];
    expect(snapshot?.toolResultBlocksReused).toBe(1);
  });

  it("leaves the previous prefix untouched when a new tool result is appended", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    const first = messagesRequest([{ id: "toolu_1", text: largeJson() }]);
    await post(handle, first);
    const firstBlock = toolResultContent(upstream.bodies[0] ?? "");

    const second = messagesRequest([
      { id: "toolu_1", text: largeJson() },
      { id: "toolu_2", text: largeJson(500) },
    ]);
    await post(handle, second);

    expect(toolResultContent(upstream.bodies[1] ?? "", 0)).toBe(firstBlock);
    expect(toolResultContent(upstream.bodies[1] ?? "", 1)).toContain("array(500)");
  });

  it("reproduces the same compact bytes after a gateway restart", async () => {
    const upstream = await fakeUpstream();
    const storeRoot = join(await mkdtemp(join(tmpdir(), "yuhi-gw-restart-")), "context");
    const request = messagesRequest([{ id: "toolu_1", text: largeJson() }]);

    const first = await gateway(upstream, { storeRoot });
    await post(first, request);
    await first.close();

    // A fresh process, same store: the delivered-block ledger restores the bytes.
    const second = await gateway(upstream, { storeRoot });
    await post(second, request);

    expect(upstream.bodies[1]).toBe(upstream.bodies[0]);
    expect(second.stats().sessions[0]?.toolResultBlocksReused).toBe(1);
  });

  it("classifies a changed block as new rather than reusing stale bytes", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson(2000) }]));
    await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson(1000) }]));

    expect(toolResultContent(upstream.bodies[1] ?? "")).toContain("array(1000)");
    expect(handle.stats().sessions[0]?.toolResultBlocksReused).toBe(0);
  });

  it("withholds, never forwards raw, when a compressor would leak private metadata", async () => {
    const leaking = {
      id: "leaking",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => ({
        compressorId: "leaking",
        compressorVersion: "1",
        text: `summary of ${ABSOLUTE_PATH}`,
        anchors: [],
        omissions: [],
        removed: [],
        tokensBefore: 10_000,
        tokensAfter: 10,
      }),
      verify: () => ({ ok: true }) as const,
    };
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream, { compressors: [leaking] });

    await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson(400) }]));
    const sent = upstream.bodies[0] ?? "";
    const delivered = toolResultContent(sent);

    expect(delivered).toContain("withheld");
    expect(delivered).toContain("private-metadata-in-output");
    expect(delivered).not.toContain(ABSOLUTE_PATH);
    // The raw tool output never reached the wire.
    expect(sent).not.toContain("user-0@example.com");
    expect(handle.stats().sessions[0]?.withheld).toBe(1);
  });

  it("degrades to a deterministic safe window when compression is unavailable", async () => {
    const broken = {
      id: "broken",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => {
        throw new Error("boom");
      },
      verify: () => ({ ok: true }) as const,
    };
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream, { compressors: [broken] });
    const lines = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join("\n");

    await post(handle, messagesRequest([{ id: "toolu_1", text: lines }]));
    const delivered = toolResultContent(upstream.bodies[0] ?? "");

    // Availability failure is not a security failure: the agent keeps working.
    expect(delivered).toContain("compression unavailable");
    expect(delivered).toContain("log line 0");
    expect(delivered).not.toContain("log line 250");
    expect(handle.stats().sessions[0]?.fallbacks).toBe(1);
  });
});

describe("slice 3 compressors through the gateway", () => {
  /** Same shape, but the agent called Bash with a test command. */
  function bashRequest(id: string, text: string, command: string): Record<string, unknown> {
    return {
      model: "claude-sonnet-5",
      max_tokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "Run the tests." }] },
        { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      ],
    };
  }

  it("routes real test output to the failures-and-anchors compressor and keeps the anchors", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    await post(handle, bashRequest("toolu_t", testRunOutput(), "pnpm test"));
    const delivered = toolResultContent(upstream.bodies[0] ?? "");

    expect(delivered).toContain("test-output-failures-and-anchors");
    expect(delivered).toContain("exit code 1");
    expect(delivered).toContain("AssertionError: expected 1170 to be 1080");
    expect(delivered).toContain("src/checkout/total.ts:42:11");
    expect(delivered).toContain("Tests  1 failed | 600 passed (601)");
    expect(delivered).not.toContain("case 300");
    expect(delivered).toMatch(/retrieve L\d+-L\d+/);

    const snapshot = handle.stats().sessions[0];
    // §3A acceptance: at least half the delivered tool-output tokens removed.
    expect(snapshot ? 1 - snapshot.deliveredEstimatedTokens / snapshot.rawEstimatedTokens : 0).toBeGreaterThan(0.5);
  });

  it("routes grep output to the grouped search compressor and preserves the match count", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    await post(handle, {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "Find computeTotal." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_g", name: "Grep", input: { pattern: "computeTotal" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_g", content: grepOutput() }] },
      ],
    });
    const delivered = toolResultContent(upstream.bodies[0] ?? "");

    expect(delivered).toContain("[search] 400 matches in 40 files");
    expect(delivered).toContain("src/module-0/handler.ts: 10 matches");
    const snapshot = handle.stats().sessions[0];
    // §3B acceptance: at least 40% removed.
    expect(snapshot ? 1 - snapshot.deliveredEstimatedTokens / snapshot.rawEstimatedTokens : 0).toBeGreaterThan(0.4);
  });

  it("routes a truncated JSON fragment to the tolerant scanner instead of giving up", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const truncated = `{"records":[${Array.from({ length: 300 }, (_, i) => `{"id":${i},"status":"${i === 219 ? "failed" : "ok"}","payload":"${"x".repeat(60)}"}`).join(",")}`;

    await post(handle, bashRequest("toolu_j", truncated, "head -c 40000 data.json"));
    const delivered = toolResultContent(upstream.bodies[0] ?? "");

    expect(delivered).toContain("json-tolerant-scan");
    expect(delivered).toContain("TRUNCATED");
    expect(delivered).toContain('"status": "failed"');
    expect(delivered).toMatch(/retrieve B\d+-B\d+/);
  });
});

describe("Anthropic compatibility", () => {
  it("streams SSE through in order and captures provider usage without buffering", async () => {
    const upstream = await fakeUpstream({ sse: true });
    const handle = await gateway(upstream);

    const response = await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson(300) }], true));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text.indexOf("message_start")).toBeLessThan(text.indexOf("content_block_delta"));
    expect(text.indexOf("content_block_delta")).toBeLessThan(text.indexOf("message_stop"));

    const usage = handle.stats().sessions[0]?.usage;
    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.cacheCreationInputTokens).toBe(300);
    expect(usage?.cacheReadInputTokens).toBe(900);
  });

  it("forwards a body it cannot parse without mangling it", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    const response = await fetch(`${handle.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    expect(response.status).toBe(200);
    expect(upstream.bodies[0]).toBe("not json at all");
  });

  it("passes non-messages paths through transparently", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);
    await fetch(`${handle.url}/v1/models`);
    expect(upstream.paths).toContain("/v1/models");
  });

  it("serves healthz, readyz and stats locally", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream);

    expect((await fetch(`${handle.url}/healthz`)).status).toBe(200);
    const ready = await fetch(`${handle.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { ok: boolean }).ok).toBe(true);
    const stats = (await (await fetch(`${handle.url}/stats`)).json()) as { upstream: string };
    expect(stats.upstream).toBe(upstream.url);
    // The upstream never saw the local endpoints.
    expect(upstream.paths).not.toContain("/healthz");
  });

  it("rejects a body over the configured limit instead of dying", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream, { maxBodyBytes: 1024 });
    const response = await post(handle, messagesRequest([{ id: "toolu_1", text: largeJson(200) }]));
    expect(response.status).toBe(413);
  });

  it("reports an unreachable upstream as an Anthropic-shaped error", async () => {
    const upstream = await fakeUpstream();
    const handle = await gateway(upstream, { upstreamBaseUrl: "http://127.0.0.1:1" });
    const response = await post(handle, messagesRequest([{ id: "toolu_1", text: "small" }]));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { type: string }).type).toBe("error");
  });
});

describe("request analysis", () => {
  it("derives a stable session id from the conversation head", () => {
    const a = messagesRequest([{ id: "t1", text: "x" }]);
    const b = messagesRequest([{ id: "t1", text: "different tool output" }]);
    expect(deriveSessionId(a)).toBe(deriveSessionId(b));
    const other = { ...a, messages: [{ role: "user", content: [{ type: "text", text: "other task" }] }] };
    expect(deriveSessionId(other)).not.toBe(deriveSessionId(a));
  });

  it("classifies content by the agent's own call before sniffing bytes", () => {
    expect(detectContentKind('{"a":1}', "Read", "/p/a.json")).toBe("json");
    expect(detectContentKind("body", "Read", "/p/a.ts")).toBe("source");
    expect(detectContentKind("Tests: 3 failed", "Bash", undefined, "pnpm test")).toBe("test-output");
    expect(detectContentKind("total 12", "Bash", undefined, "ls -la")).toBe("shell-output");
    expect(detectContentKind("diff --git a/x b/x", "Bash")).toBe("git-diff");
    expect(detectContentKind("2026-08-03T00:00:00Z INFO started")).toBe("log");
    expect(detectContentKind("src/a.ts:12:match", "Grep")).toBe("text");
  });

  it("only treats tool_result content paths as the live zone", () => {
    expect(isToolResultContentPath("$.messages[2].content[0].content")).toBe(true);
    expect(isToolResultContentPath("$.messages[2].content[0].content[1].text")).toBe(true);
    expect(isToolResultContentPath("$.system[0].text")).toBe(false);
    expect(isToolResultContentPath("$.messages[1].content[0].input.file_path")).toBe(false);
  });

  it("extracts the last complete usage frame from a partial stream window", () => {
    const window = `data: {"usage":{"input_tokens":10,"output_tokens":1}}\n\ndata: {"usage":{"input_tokens":20,"cache_read_input_tokens":5,"output`;
    expect(extractUsage(window)).toEqual({ inputTokens: 10, outputTokens: 1 });
  });
});
