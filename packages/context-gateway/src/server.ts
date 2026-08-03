/**
 * The Yuhi local Anthropic-compatible gateway (spec §2, §11, §13).
 *
 *   Claude Code → ANTHROPIC_BASE_URL=http://127.0.0.1:<port> → Yuhi → upstream
 *
 * Anthropic Messages API compatible: `POST /v1/messages` is transformed, every other
 * path is transparently forwarded, and `/healthz` `/readyz` `/stats` are local-only
 * operational endpoints. Loopback bind by default — this is a personal runtime, not a
 * shared service.
 *
 * Credentials are forwarded and never logged, stored, or written to evidence.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ContextStore, asSessionId, type SessionId } from "@yuhi/context-store";
import {
  ContextRuntime,
  type ContextRuntimeOptions,
  type FallbackPolicy,
  type RetrievalLimits,
} from "@yuhi/context-runtime";
import type { Compressor } from "@yuhi/context-compression";

import { transformRequest, type TransformDeps } from "./anthropic/transform.js";
import { copyResponseHeaders, forwardRequest, pipeWithUsageCapture, type FetchLike } from "./anthropic/upstream.js";
import { GatewayMetrics, type MetricsSnapshot } from "./session/metrics.js";
import { PrefixState } from "./session/prefix-state.js";

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface GatewayOptions {
  /** Context store root, e.g. `<prepared>/.yuhi/context`. */
  readonly storeRoot: string;
  readonly upstreamBaseUrl?: string;
  readonly host?: string;
  /** 0 (default) asks the OS for a free port — avoids clashing with anything. */
  readonly port?: number;
  readonly now?: () => string;
  readonly fetchImpl?: FetchLike;
  readonly maxBodyBytes?: number;
  readonly compressionTimeoutMs?: number;
  readonly fallbackPolicy?: FallbackPolicy;
  readonly retrievalLimits?: RetrievalLimits;
  readonly tokenBudget?: number;
  /** Fixed session id (benchmarks/tests). Production derives it from the conversation. */
  readonly sessionOverride?: string;
  /** Compressor set override (benchmarks/tests). Defaults to the built-in kernel. */
  readonly compressors?: readonly Compressor[];
  readonly log?: (line: string) => void;
}

export interface GatewayHandle {
  readonly url: string;
  readonly port: number;
  readonly storeRoot: string;
  stats(): GatewayStats;
  close(): Promise<void>;
}

export interface GatewayStats {
  readonly upstream: string;
  readonly startedAt: string;
  readonly requests: number;
  readonly sessions: readonly MetricsSnapshot[];
}

export async function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const store = await ContextStore.open({ root: opts.storeRoot, ...(opts.now ? { now: opts.now } : {}) });
  const now = opts.now ?? (() => new Date().toISOString());
  const upstream = opts.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024 * 1024;
  const log = opts.log ?? ((): void => {});
  const startedAt = now();

  const runtimeOptions: ContextRuntimeOptions = {
    store,
    now,
    ...(opts.compressionTimeoutMs === undefined ? {} : { timeoutMs: opts.compressionTimeoutMs }),
    ...(opts.fallbackPolicy ? { fallbackPolicy: opts.fallbackPolicy } : {}),
    ...(opts.retrievalLimits ? { retrievalLimits: opts.retrievalLimits } : {}),
    ...(opts.tokenBudget === undefined ? {} : { tokenBudget: opts.tokenBudget }),
    ...(opts.compressors ? { compressors: opts.compressors } : {}),
  };
  const runtime = new ContextRuntime(runtimeOptions);

  const prefixes = new Map<string, PrefixState>();
  const metrics = new Map<string, GatewayMetrics>();
  let requests = 0;

  const deps: TransformDeps = {
    runtime,
    prefixFor: async (sessionId) => {
      const existing = prefixes.get(sessionId);
      if (existing) return existing;
      // Loading from the ledger is what makes a restart reproduce identical bytes.
      const loaded = await PrefixState.load(store, sessionId, now);
      prefixes.set(sessionId, loaded);
      return loaded;
    },
    metricsFor: (sessionId) => {
      const existing = metrics.get(sessionId);
      if (existing) return existing;
      const created = new GatewayMetrics(sessionId);
      metrics.set(sessionId, created);
      return created;
    },
  };

  const stats = (): GatewayStats => ({
    upstream,
    startedAt,
    requests,
    sessions: [...metrics.values()].map((m) => m.snapshot()),
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`gateway error: ${err instanceof Error ? err.name : "unknown"}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "gateway_failure" } }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? "/";

    if (req.method === "GET" && path.startsWith("/healthz")) {
      return json(res, 200, { status: "ok", startedAt });
    }
    if (req.method === "GET" && path.startsWith("/readyz")) {
      const ready = await isReady(store, now);
      return json(res, ready.ok ? 200 : 503, ready);
    }
    if (req.method === "GET" && path.startsWith("/stats")) {
      return json(res, 200, stats());
    }

    const body = await readBody(req, maxBodyBytes);
    if (body === "too-large") {
      return json(res, 413, { type: "error", error: { type: "invalid_request_error", message: "request_too_large" } });
    }

    requests++;
    const controller = new AbortController();
    // A disconnected client must cancel the upstream call, not orphan it.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let outBody = body;
    let sessionId: SessionId | undefined;
    if (req.method === "POST" && path.startsWith("/v1/messages") && !path.includes("count_tokens")) {
      const outcome = await transformRequest(body, deps, opts.sessionOverride);
      sessionId = outcome.sessionId;
      outBody = outcome.body;
      deps.metricsFor(outcome.sessionId).request();
      if (outcome.liveZoneViolations.length > 0) {
        log(`live-zone violation: ${outcome.liveZoneViolations.length} path(s) outside tool_result content`);
      }
    }

    let response: Response;
    try {
      response = await forwardRequest({
        upstreamBaseUrl: upstream,
        path,
        method: req.method ?? "POST",
        headers: req.headers,
        ...(outBody.byteLength > 0 ? { body: outBody } : {}),
        signal: controller.signal,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    } catch (err) {
      if (sessionId) deps.metricsFor(sessionId).upstreamError();
      if (controller.signal.aborted) return;
      return json(res, 502, {
        type: "error",
        error: { type: "api_error", message: `upstream_unreachable:${err instanceof Error ? err.name : "unknown"}` },
      });
    }

    res.statusCode = response.status;
    copyResponseHeaders(response, res);
    await pipeWithUsageCapture(response, res, (usage) => {
      if (sessionId) deps.metricsFor(sessionId).observeUsage(usage);
    });

    if (sessionId) {
      // Persist the snapshot so `yuhi dynamic stats` works after the gateway exits.
      await store.writeState(sessionId, "gateway-stats", deps.metricsFor(sessionId).snapshot()).catch(() => {});
    }
  }

  const port = await listen(server, opts.host ?? "127.0.0.1", opts.port ?? 0);

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    storeRoot: opts.storeRoot,
    stats,
    close: async () => {
      for (const [sessionId, m] of metrics) {
        await store.writeState(asSessionId(sessionId), "gateway-stats", m.snapshot()).catch(() => {});
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function isReady(store: ContextStore, now: () => string): Promise<{ ok: boolean; checks: Record<string, boolean> }> {
  const probe = asSessionId("readyz-probe");
  let storeWritable = false;
  try {
    await store.writeState(probe, "readyz", { at: now() });
    storeWritable = (await store.readState(probe, "readyz")) !== undefined;
  } catch {
    storeWritable = false;
  }
  const checks = { storeWritable };
  return { ok: Object.values(checks).every(Boolean), checks };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) return "too-large";
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("gateway-listen-failed"));
    });
  });
}
