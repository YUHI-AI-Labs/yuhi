/**
 * v0.4.1 Phase 0.2 probe harness — NOT product code.
 *
 * Starts one dynamic-context session through the SHIPPED launcher
 * (`startDynamicClaudeSession`) so the probe observes exactly the gateway the CLI and the
 * Dynamic Terminal already use. It spawns nothing: it prints the endpoint plus the four
 * environment variables, writes them to `env.json` for the launch step, and then watches
 * `requests` so a human can see the moment the official extension's `claude` child talks
 * through the gateway.
 *
 * Run:  pnpm tsx scripts/probe-native-gui.ts
 * Stop: Ctrl-C — prints final stats and flushes the evidence ledger.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startDynamicClaudeSession, startGateway } from "../packages/context-gateway/src/index.js";

const PROBE_ROOT = process.env.YUHI_PROBE_ROOT ?? "/tmp/yuhi-native-gui-probe";
const WORKSPACE = join(PROBE_ROOT, "workspace");
const LABEL = process.env.YUHI_PROBE_LABEL ?? "unlabelled";
const OBSERVED = join(PROBE_ROOT, "evidence", `observed-${LABEL}.jsonl`);

/**
 * Observation only. Records the fields the feasibility evidence needs — path, model, stream
 * flag, HTTP status, timestamp — and NOTHING else. Headers are never touched (they carry the
 * provider credential) and the request body is parsed solely to read `model` and `stream`;
 * the prompt text is discarded with the parse. This satisfies CLAUDE.md conflict #4: evidence
 * never carries a raw value.
 */
const recordingFetch = async (url: string, init: RequestInit): Promise<Response> => {
  let model: string | undefined;
  let stream: boolean | undefined;
  try {
    // `forwardRequest` passes a Buffer, not a string.
    const raw =
      typeof init.body === "string"
        ? init.body
        : Buffer.isBuffer(init.body)
          ? init.body.toString("utf8")
          : undefined;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    if (body) {
      model = typeof body["model"] === "string" ? body["model"] : undefined;
      stream = Boolean(body["stream"]);
    }
  } catch {
    // non-JSON body (a forwarded non-messages path) — nothing to record
  }
  const ts = new Date().toISOString();
  const response = await (globalThis.fetch as typeof fetch)(url, init);
  await appendFile(
    OBSERVED,
    `${JSON.stringify({ ts, path: new URL(url).pathname, model, stream, status: response.status })}\n`,
    "utf8",
  );
  return response;
};

async function main(): Promise<void> {
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(join(PROBE_ROOT, "evidence"), { recursive: true });

  const session = await startDynamicClaudeSession({
    preparedWorkspace: WORKSPACE,
    sessionId: "probe_native_gui",
    log: (line) => console.log(line),
    startGatewayImpl: (opts) => startGateway({ ...opts, fetchImpl: recordingFetch }),
  });

  const env = session.command.env;
  await writeFile(join(PROBE_ROOT, "env.json"), `${JSON.stringify(env, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`gateway      ${session.gatewayUrl}`);
  console.log(`session      ${session.sessionId}`);
  console.log(`contextRoot  ${session.contextRoot}`);
  console.log(`delivery     ${session.deliveryMode}   retrieval ${session.retrievalMode}`);
  console.log("");
  console.log("env for the isolated VS Code (also written to env.json):");
  for (const [k, v] of Object.entries(env)) console.log(`  ${k}=${v}`);
  console.log("");
  console.log("watching for requests — send the probe prompt in the isolated window.");

  let seen = 0;
  const tick = setInterval(async () => {
    const stats = await session.getStats();
    if (stats.requests !== seen) {
      seen = stats.requests;
      console.log(`[probe] requests=${seen} upstream=${stats.upstream}`);
      console.log(`[probe] sessions=${JSON.stringify(stats.sessions)}`);
    }
  }, 1000);

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    const stats = await session.close();
    console.log("");
    console.log(`FINAL requests=${stats.requests}`);
    console.log(JSON.stringify(stats, null, 2));
    console.log(stats.requests > 0 ? "GATEWAY SAW TRAFFIC" : "NO TRAFFIC — gate not satisfied");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
