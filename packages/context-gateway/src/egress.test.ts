/**
 * Egress guard and Developer Mode end-to-end through the gateway.
 *
 * Developer Mode hands the agent real configuration on purpose. These tests check the two
 * things that makes acceptable: the value reaches the agent, and its reappearance on an
 * outbound path is detected and audited — with the ledger carrying fingerprints, never values.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STRICT_MODE_POLICY } from "@yuhi/context-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { EgressGuard, fingerprint } from "./policy/egress-guard.js";
import { startGateway, type GatewayHandle } from "./server.js";

const SYNTHETIC_KEY = "sk-ant-api03-SYNTHETIC0000000000000000000000000000000000000000000000000000";
const DOTENV = [
  "API_URL=https://api.staging.example.com",
  "MODEL_NAME=claude-sonnet-4-5",
  `SYNTHETIC_API_KEY=${SYNTHETIC_KEY}`,
].join("\n");

interface FakeUpstream {
  url: string;
  bodies: string[];
  /** Text the fake model "says" back, so response-side egress can be exercised. */
  reply: string;
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
  const state = { reply: "ok" };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ delta: { text: state.reply } })}\n\n`);
    res.end();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : 0);
    });
  });
  const upstream: FakeUpstream = {
    url: `http://127.0.0.1:${port}`,
    bodies,
    get reply() {
      return state.reply;
    },
    set reply(value: string) {
      state.reply = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  open.upstreams.push(upstream);
  return upstream;
}

async function gateway(upstream: FakeUpstream, extra: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<{ handle: GatewayHandle; root: string }> {
  const root = extra.storeRoot ?? join(await mkdtemp(join(tmpdir(), "yuhi-egress-")), "context");
  const handle = await startGateway({
    storeRoot: root,
    upstreamBaseUrl: upstream.url,
    sessionOverride: "egress-session",
    now: () => "2026-08-04T00:00:00.000Z",
    ...extra,
  });
  open.gateways.push(handle);
  return { handle, root };
}

/** A turn where the agent read `.env`, plus optional follow-up tool_use input. */
function request(toolInput?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: [{ type: "text", text: "Why can't the app reach the API?" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: "/repo/.env" } },
          ...(toolInput ? [{ type: "tool_use", id: "toolu_write", name: "Write", input: toolInput }] : []),
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_env", content: DOTENV }] },
    ],
  };
}

async function post(handle: GatewayHandle, body: unknown): Promise<Response> {
  return fetch(`${handle.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "never-logged" },
    body: JSON.stringify(body),
  });
}

async function ledgerText(root: string): Promise<string> {
  const dir = join(root, "evidence");
  const files = await readdir(dir).catch(() => []);
  const parts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8").catch(() => "")));
  return parts.join("\n");
}

describe("Developer Mode through the gateway", () => {
  it("forwards configuration values to the provider, as the developer asked", async () => {
    const upstream = await fakeUpstream();
    const { handle } = await gateway(upstream);

    await post(handle, request());
    // The whole point: the agent can see it.
    expect(upstream.bodies[0]).toContain(SYNTHETIC_KEY);
    expect(upstream.bodies[0]).toContain("API_URL=https://api.staging.example.com");
    void handle;
  });

  it("masks the same value under Strict Mode, without any other change", async () => {
    const upstream = await fakeUpstream();
    const { handle } = await gateway(upstream, { deliveryPolicy: STRICT_MODE_POLICY });

    await post(handle, request());
    expect(upstream.bodies[0]).not.toContain(SYNTHETIC_KEY);
    expect(upstream.bodies[0]).toContain("API_URL=");
  });

  it("keeps every raw value out of evidence and statistics", async () => {
    const upstream = await fakeUpstream();
    const { handle, root } = await gateway(upstream);

    await post(handle, request());
    const evidence = await ledgerText(root);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence).not.toContain(SYNTHETIC_KEY);
    // The finding IS recorded — as a fingerprint and a policy name.
    expect(evidence).toContain(fingerprint(SYNTHETIC_KEY));
    expect(evidence).toContain("developer");
    expect(JSON.stringify(handle.stats())).not.toContain(SYNTHETIC_KEY);
  });
});

describe("egress detection", () => {
  it("records a delivered secret reappearing in the model's answer", async () => {
    const upstream = await fakeUpstream();
    const { handle, root } = await gateway(upstream);

    await post(handle, request());
    // The model now pastes the key into its reply.
    upstream.reply = `Set it in production: ${SYNTHETIC_KEY}`;
    await post(handle, request());

    const evidence = await ledgerText(root);
    expect(evidence).toContain('"type":"egress-detection"');
    expect(evidence).toContain('"direction":"response"');
    expect(evidence).toContain(fingerprint(SYNTHETIC_KEY));
    // Audited, never stored.
    expect(evidence).not.toContain(SYNTHETIC_KEY);
    expect(handle.stats().sessions[0]?.egressDetections).toBeGreaterThan(0);
  });

  it("records a delivered secret being written into a file or patch", async () => {
    const upstream = await fakeUpstream();
    const { handle, root } = await gateway(upstream);

    await post(handle, request());
    await post(handle, request({ file_path: "/repo/README.md", content: `key: ${SYNTHETIC_KEY}` }));

    const evidence = await ledgerText(root);
    expect(evidence).toContain('"direction":"request"');
    expect(evidence).toContain('"surface":"Write"');
    expect(evidence).not.toContain(SYNTHETIC_KEY);
  });

  it("does not block the write it detected", async () => {
    const upstream = await fakeUpstream();
    const { handle } = await gateway(upstream);

    await post(handle, request());
    const response = await post(handle, request({ file_path: "/repo/x", content: SYNTHETIC_KEY }));

    // v0.4.0 detects, warns and audits. Blocking is Enterprise Strict Mode's job.
    expect(response.status).toBe(200);
    expect(upstream.bodies[1]).toContain(SYNTHETIC_KEY);
  });
});

describe("EgressGuard unit behaviour", () => {
  it("matches values it was given and reports counts, never values", () => {
    const guard = new EgressGuard();
    guard.watch([SYNTHETIC_KEY, "short"]);
    expect(guard.watchedCount).toBe(1);

    const verdict = guard.scan(`a ${SYNTHETIC_KEY} b ${SYNTHETIC_KEY}`, "response", "assistant-message");
    expect(verdict.detected).toBe(true);
    expect(verdict.occurrences).toBe(2);
    expect(verdict.hits[0]?.fingerprint).toBe(fingerprint(SYNTHETIC_KEY));
    expect(JSON.stringify(verdict)).not.toContain(SYNTHETIC_KEY);
  });

  it("says nothing when nothing left", () => {
    const guard = new EgressGuard();
    guard.watch([SYNTHETIC_KEY]);
    expect(guard.scan("an ordinary sentence", "response", "assistant-message").detected).toBe(false);
  });

  it("warns in a way that names the surface, not the secret", () => {
    const guard = new EgressGuard();
    guard.watch([SYNTHETIC_KEY]);
    const warning = EgressGuard.warning(guard.scan(SYNTHETIC_KEY, "request", "Write"));
    expect(warning).toContain("outbound request (Write)");
    expect(warning).toContain("does not block it");
    expect(warning).not.toContain(SYNTHETIC_KEY);
  });
});
