/**
 * Benchmark matrix runner (spec §16, §17).
 *
 * Runs conditions × models × tasks × n, each in a fresh fixture, and reports median WITH
 * variation (min/max and IQR) — a single number hides the run-to-run spread that decides
 * whether a claim is real.
 *
 *   npx tsx packages/context-benchmark/scripts/matrix.mts \
 *     --tasks test-failure,grep-exploration --conditions baseline,dynamic-yuhi \
 *     --models claude-haiku-4-5-20251001 --runs 3 --out /tmp/matrix
 *
 * Provider usage and cost come from Claude Code's own `--output-format json`; Yuhi's own
 * numbers are labelled as estimates and never mixed with them.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startGateway } from "../../context-gateway/src/index.js";
import { tallyRetrievals } from "../../context-runtime/src/index.js";
import { ContextStore, asSessionId } from "../../context-store/src/index.js";
import { createFixture, TASK_ORACLE, TASK_PROMPTS, type TaskId } from "./fixtures.mts";

type Condition = "baseline" | "static-yuhi" | "dynamic-yuhi";

interface RunRecord {
  task: TaskId;
  condition: Condition;
  model: string;
  run: number;
  ok: boolean;
  taskSuccess: boolean;
  answer: string;
  turns: number;
  durationMs: number;
  costUsd?: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  inputSideTotal: number;
  // Yuhi's own estimates (dynamic only)
  rawToolTokens?: number;
  deliveredToolTokens?: number;
  dynamicReduction?: number;
  blocksObserved?: number;
  blocksCompressed?: number;
  blocksReused?: number;
  fallbacks?: number;
  withheld?: number;
  retrievals?: number;
  retrievalsWithheld?: number;
  liveZoneViolations?: number;
  medianCompressionLatencyMs?: number;
  peakRssBytes?: number;
}

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/dist/index.js");

const RETRIEVAL_TOOLS = [
  "mcp__yuhi__yuhi_retrieve",
  "mcp__yuhi__yuhi_get_json_path",
  "mcp__yuhi__yuhi_get_lines",
  "mcp__yuhi__yuhi_explain_context",
];

async function writeMcpConfig(workspace: string, contextRoot: string, sessionId: string): Promise<string> {
  const path = join(workspace, "yuhi-mcp.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        yuhi: {
          command: process.execPath,
          args: [CLI_ENTRY, "mcp", "serve"],
          env: { YUHI_CONTEXT_ROOT: contextRoot, YUHI_SESSION_ID: sessionId },
        },
      },
    }),
  );
  return path;
}

interface ClaudeOutcome {
  exitCode: number;
  durationMs: number;
  answer: string;
  turns: number;
  costUsd?: number;
  usage: Record<string, number>;
  mcpToolCalls: number;
}

async function runClaude(opts: {
  workspace: string;
  prompt: string;
  model: string;
  env: Record<string, string>;
  mcpConfig?: string;
  timeoutMs: number;
}): Promise<ClaudeOutcome> {
  const tools = ["Read", "Bash", "Glob", "Grep", ...(opts.mcpConfig ? RETRIEVAL_TOOLS : [])];
  const argv = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--allowedTools",
    tools.join(","),
    "--model",
    opts.model,
    ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig, "--strict-mcp-config"] : []),
  ];
  const began = Date.now();

  return new Promise<ClaudeOutcome>((resolveRun) => {
    const child = spawn("claude", argv, {
      cwd: opts.workspace,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const usage = (parsed["usage"] ?? {}) as Record<string, number>;
      resolveRun({
        exitCode: code ?? 1,
        durationMs: Date.now() - began,
        answer: typeof parsed["result"] === "string" ? (parsed["result"] as string) : "",
        turns: typeof parsed["num_turns"] === "number" ? (parsed["num_turns"] as number) : 0,
        ...(typeof parsed["total_cost_usd"] === "number" ? { costUsd: parsed["total_cost_usd"] as number } : {}),
        usage,
        mcpToolCalls: (stdout.match(/mcp__yuhi__/g) ?? []).length,
      });
    });
  });
}

async function runOne(
  task: TaskId,
  condition: Condition,
  model: string,
  run: number,
  timeoutMs: number,
  /**
   * Register the MCP retrieval server. Off isolates a real effect we measured: the tool
   * definitions themselves enter the cached system prompt on every request, so the
   * retrieval capability has a token cost even in a session that never retrieves.
   */
  withMcp = true,
): Promise<RunRecord> {
  const workspace = await mkdtemp(join(tmpdir(), `yuhi-bench-${task}-`));
  await createFixture(workspace, task);
  const prompt = TASK_PROMPTS[task];

  let outcome: ClaudeOutcome;
  let gatewayStats: Record<string, number> | undefined;
  let retrievalTally = { delivered: 0, withheld: 0 };

  if (condition === "dynamic-yuhi") {
    const contextRoot = join(workspace, ".yuhi", "context");
    await mkdir(contextRoot, { recursive: true });
    const sessionId = `bench-${task}-${run}`;
    const gateway = await startGateway({ storeRoot: contextRoot, sessionOverride: sessionId });
    const mcpConfig = withMcp ? await writeMcpConfig(workspace, contextRoot, sessionId) : undefined;
    try {
      outcome = await runClaude({
        workspace,
        prompt,
        model,
        env: { ANTHROPIC_BASE_URL: gateway.url },
        ...(mcpConfig ? { mcpConfig } : {}),
        timeoutMs,
      });
      gatewayStats = gateway.stats().sessions[0] as unknown as Record<string, number>;
      // Retrievals happen in the MCP server's process; the ledger is the only witness.
      const store = await ContextStore.open({ root: contextRoot });
      const tally = await tallyRetrievals(store, asSessionId(sessionId));
      retrievalTally = { delivered: tally.delivered, withheld: tally.withheld };
    } finally {
      await gateway.close();
    }
  } else {
    outcome = await runClaude({ workspace, prompt, model, env: {}, timeoutMs });
  }

  const usage = outcome.usage;
  const inputTokens = usage["input_tokens"] ?? 0;
  const cacheCreationTokens = usage["cache_creation_input_tokens"] ?? 0;
  const cacheReadTokens = usage["cache_read_input_tokens"] ?? 0;

  return {
    task,
    condition,
    model,
    run,
    ok: outcome.exitCode === 0,
    taskSuccess: TASK_ORACLE[task](outcome.answer),
    answer: outcome.answer.slice(0, 300),
    turns: outcome.turns,
    durationMs: outcome.durationMs,
    ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens: usage["output_tokens"] ?? 0,
    inputSideTotal: inputTokens + cacheCreationTokens + cacheReadTokens,
    ...(gatewayStats
      ? {
          rawToolTokens: gatewayStats["rawEstimatedTokens"] ?? 0,
          deliveredToolTokens: gatewayStats["deliveredEstimatedTokens"] ?? 0,
          dynamicReduction: gatewayStats["dynamicReduction"] ?? 0,
          blocksObserved: gatewayStats["toolResultBlocksObserved"] ?? 0,
          blocksCompressed: gatewayStats["toolResultBlocksCompressed"] ?? 0,
          blocksReused: gatewayStats["toolResultBlocksReused"] ?? 0,
          fallbacks: gatewayStats["fallbacks"] ?? 0,
          withheld: gatewayStats["withheld"] ?? 0,
          retrievals: retrievalTally.delivered,
          retrievalsWithheld: retrievalTally.withheld,
          liveZoneViolations: gatewayStats["liveZoneViolations"] ?? 0,
          medianCompressionLatencyMs: gatewayStats["medianCompressionLatencyMs"] ?? 0,
          peakRssBytes: gatewayStats["peakRssBytes"] ?? 0,
        }
      : {}),
  };
}

// ------------------------------------------------------------------ aggregation

export interface Spread {
  median: number;
  min: number;
  max: number;
  q1: number;
  q3: number;
  n: number;
}

export function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx] ?? 0;
  };
  return {
    median: at(0.5),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    q1: at(0.25),
    q3: at(0.75),
    n: sorted.length,
  };
}

function fmt(s: Spread): string {
  return `${round(s.median)} [${round(s.min)}–${round(s.max)}] IQR ${round(s.q1)}–${round(s.q3)} (n=${s.n})`;
}

function round(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2).replace(/\.00$/, "");
  return n.toFixed(4);
}

function report(records: readonly RunRecord[]): string {
  const lines: string[] = ["# Yuhi v0.4.0 benchmark matrix", ""];
  const tasks = [...new Set(records.map((r) => r.task))];
  const models = [...new Set(records.map((r) => r.model))];

  for (const model of models) {
    for (const task of tasks) {
      lines.push(`## ${task} · ${model}`, "");
      lines.push("| metric | " + [...new Set(records.map((r) => r.condition))].join(" | ") + " |");
      lines.push("|---|" + [...new Set(records.map((r) => r.condition))].map(() => "---|").join(""));
      const conditions = [...new Set(records.map((r) => r.condition))];
      const rows: [string, (r: RunRecord) => number][] = [
        ["task success rate", (r) => (r.taskSuccess ? 1 : 0)],
        ["turns", (r) => r.turns],
        ["provider input tokens", (r) => r.inputTokens],
        ["cache creation tokens", (r) => r.cacheCreationTokens],
        ["cache read tokens", (r) => r.cacheReadTokens],
        ["input-side total", (r) => r.inputSideTotal],
        ["output tokens", (r) => r.outputTokens],
        ["provider cost USD", (r) => r.costUsd ?? 0],
        ["wall clock ms", (r) => r.durationMs],
        ["dynamic tool-output reduction", (r) => r.dynamicReduction ?? 0],
        ["retrievals delivered (ledger)", (r) => r.retrievals ?? 0],
        ["retrievals refused (ledger)", (r) => r.retrievalsWithheld ?? 0],
        ["fallbacks", (r) => r.fallbacks ?? 0],
        ["withheld", (r) => r.withheld ?? 0],
        ["live-zone violations", (r) => r.liveZoneViolations ?? 0],
        ["compression latency ms", (r) => r.medianCompressionLatencyMs ?? 0],
      ];
      for (const [label, pick] of rows) {
        const cells = conditions.map((condition) => {
          const subset = records.filter((r) => r.task === task && r.model === model && r.condition === condition);
          if (subset.length === 0) return "—";
          return fmt(spread(subset.map(pick)));
        });
        lines.push(`| ${label} | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }
  }
  lines.push(
    "Dynamic tool-output reduction is Yuhi's own ESTIMATE of withheld tool output.",
    "Provider input/cache/output tokens and cost are PROVIDER-REPORTED via Claude Code's JSON output.",
    "The two must never be added together or presented as one number.",
  );
  return lines.join("\n");
}

// ------------------------------------------------------------------------ main

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const tasks = arg("tasks", "large-json").split(",") as TaskId[];
const conditions = arg("conditions", "baseline,dynamic-yuhi").split(",") as Condition[];
const models = arg("models", "claude-haiku-4-5-20251001").split(",");
const runs = Number(arg("runs", "3"));
const timeoutMs = Number(arg("timeout", "240000"));
const out = arg("out", "");
const withMcp = process.argv.indexOf("--no-mcp") === -1;

const records: RunRecord[] = [];
// Interleave conditions per run index so drift in service latency hits both equally.
for (let run = 1; run <= runs; run++) {
  for (const task of tasks) {
    for (const model of models) {
      for (const condition of conditions) {
        const record = await runOne(task, condition, model, run, timeoutMs, withMcp);
        records.push(record);
        console.error(
          `[${task}/${condition}/${model}/run${run}] success=${record.taskSuccess} turns=${record.turns} cost=${record.costUsd ?? "?"} inputSide=${record.inputSideTotal} dynRed=${record.dynamicReduction ?? "-"}`,
        );
      }
    }
  }
}

const markdown = report(records);
if (out !== "") {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "runs.json"), JSON.stringify(records, null, 2));
  await writeFile(join(out, "report.md"), markdown);
}
console.log(markdown);
