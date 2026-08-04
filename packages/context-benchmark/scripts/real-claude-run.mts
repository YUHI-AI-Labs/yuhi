/**
 * Real Claude Code benchmark runner (spec §16).
 *
 * Runs an actual `claude -p` session under one of the three conditions and records the
 * PROVIDER-reported usage and cost from Claude Code's own `--output-format json`. That
 * is the only honest source for "actual provider input reduction" and "actual cost
 * impact" (§17) — everything Yuhi computes itself is an estimate and is labelled as one.
 *
 * Usage:
 *   npx tsx packages/context-benchmark/scripts/real-claude-run.mts \
 *     --condition dynamic --workspace /tmp/bench --task large-json \
 *     --model claude-haiku-4-5-20251001 --out /tmp/bench/dynamic-1.json
 *
 * Conditions:
 *   baseline     plain Claude Code, no Yuhi
 *   static-yuhi  Claude Code in a Prepared Repository (run `yuhi prepare` first)
 *   dynamic-yuhi Claude Code through the Yuhi gateway (this script starts it)
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startGateway } from "../../context-gateway/src/index.js";

interface Args {
  condition: "baseline" | "static-yuhi" | "dynamic-yuhi";
  workspace: string;
  task: string;
  model?: string;
  prompt?: string;
  out?: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const condition = (get("condition") ?? "baseline") as Args["condition"];
  return {
    condition,
    workspace: get("workspace") ?? process.cwd(),
    task: get("task") ?? "large-json",
    ...(get("model") ? { model: get("model") as string } : {}),
    ...(get("prompt") ? { prompt: get("prompt") as string } : {}),
    ...(get("out") ? { out: get("out") as string } : {}),
    timeoutMs: Number(get("timeout") ?? 180_000),
  };
}

const TASK_PROMPTS: Record<string, string> = {
  "large-json":
    "Read data.json. Find the single record whose status is not ok, report its id and the error message, and say nothing else.",
  "repeated-json":
    "Read data.json and report how many records it holds. Then read data.json again and report the id of the record whose status is not ok.",
  "test-failure":
    "Run `bash run-tests.sh`. Report which tests failed and the assertion message for each. Do not fix anything.",
};

interface ClaudeResult {
  exitCode: number;
  durationMs: number;
  raw: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  costUsd?: number;
  answer?: string;
  numTurns?: number;
}

async function runClaude(args: Args, extraEnv: Record<string, string>): Promise<ClaudeResult> {
  const prompt = args.prompt ?? TASK_PROMPTS[args.task] ?? TASK_PROMPTS["large-json"]!;
  const argv = [
    "-p",
    prompt,
    "--output-format",
    "json",
    // Read-only tools: a benchmark must never write to the user's tree.
    "--allowedTools",
    "Read,Bash,Glob,Grep",
    ...(args.model ? ["--model", args.model] : []),
  ];

  const began = Date.now();
  return new Promise<ClaudeResult>((resolve) => {
    const child = spawn("claude", argv, {
      cwd: args.workspace,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), args.timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - began;
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      resolve({
        exitCode: code ?? 1,
        durationMs,
        raw: stdout.slice(0, 4000) + (stderr ? `\n[stderr] ${stderr.slice(0, 1000)}` : ""),
        ...(parsed?.["usage"] ? { usage: parsed["usage"] as ClaudeResult["usage"] } : {}),
        ...(typeof parsed?.["total_cost_usd"] === "number" ? { costUsd: parsed["total_cost_usd"] } : {}),
        ...(typeof parsed?.["result"] === "string" ? { answer: parsed["result"] as string } : {}),
        ...(typeof parsed?.["num_turns"] === "number" ? { numTurns: parsed["num_turns"] as number } : {}),
      });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const record: Record<string, unknown> = { condition: args.condition, task: args.task, model: args.model ?? "default" };

  if (args.condition !== "dynamic-yuhi") {
    const result = await runClaude(args, {});
    Object.assign(record, { claude: result });
  } else {
    const storeRoot = join(args.workspace, ".yuhi", "context");
    await mkdir(storeRoot, { recursive: true });
    const gateway = await startGateway({
      storeRoot,
      sessionOverride: `bench-${args.task}`,
      log: (line) => console.error(`[gateway] ${line}`),
    });
    console.error(`[gateway] listening on ${gateway.url}`);
    try {
      const result = await runClaude(args, { ANTHROPIC_BASE_URL: gateway.url });
      Object.assign(record, { claude: result, gateway: gateway.stats() });
    } finally {
      await gateway.close();
    }
  }

  const json = JSON.stringify(record, null, 2);
  if (args.out) await writeFile(args.out, json);
  console.log(json);
}

await main();
