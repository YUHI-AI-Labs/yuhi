/**
 * Deterministic benchmark fixtures (spec §16). A fixed repository snapshot and fixed
 * prompts are what make three runs comparable; nothing here uses randomness or the clock.
 *
 *   npx tsx packages/context-benchmark/scripts/fixtures.mts <dir> [task]
 */

import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export type TaskId =
  | "large-json"
  | "repeated-json"
  | "test-failure"
  | "large-log"
  | "grep-exploration"
  | "retrieval-required"
  | "multi-file-bug";

export const TASK_PROMPTS: Record<TaskId, string> = {
  "large-json":
    "Read data.json. Find the single record whose status is not ok, report its id and the error message, and say nothing else.",
  "repeated-json":
    "Read data.json and report how many records it holds. Then consult data.json again and report the id of the record whose status is not ok. Report both numbers and nothing else.",
  "test-failure":
    "Run `bash run-tests.sh`. Report the name of each failing test, its assertion message, and the source file and line each failure points at. Do not fix anything.",
  "large-log":
    "Read server.log. Report the error message that appears in it and the timestamp of the first occurrence. Nothing else.",
  "grep-exploration":
    "Run `grep -rn computeTotal src/` and, from that output, list the three files with the most occurrences, each with its count. Nothing else.",
  "retrieval-required":
    "Read data.json. Report the exact value of the `checked_at` field of the record whose id is 618, and its `region`. Report only those two values.",
  "multi-file-bug":
    "Run `bash run-tests.sh`, then report which source file and line must change to fix the failing test, and what the fix is. Do not edit any file.",
};

/** Records shaped like a batch-processing report; exactly one record fails. */
function records(count: number, failingIndex: number): unknown[] {
  return Array.from({ length: count }, (_, i) => {
    const base = {
      id: i + 1,
      name: `record-${i}`,
      status: i === failingIndex ? "failed" : "ok",
      region: i % 3 === 0 ? "ap-northeast-1" : i % 3 === 1 ? "us-east-1" : "eu-west-1",
      checked_at: `2026-08-0${(i % 9) + 1}T0${i % 10}:${String(i % 60).padStart(2, "0")}:00Z`,
      payload: "x".repeat(80),
    };
    return i === failingIndex
      ? { ...base, error: "connection reset by peer while committing batch 532" }
      : base;
  });
}

async function writeJsonFixture(dir: string): Promise<void> {
  await writeFile(join(dir, "data.json"), JSON.stringify({ generated: "2026-08-04", records: records(800, 531) }));
}

/** A test script whose output looks like a real run: noise around three failures. */
async function writeTestFixture(dir: string): Promise<void> {
  const lines: string[] = ["#!/usr/bin/env bash", "set -u", 'echo "$ vitest run"', 'echo ""', 'echo " RUN  v2.1.9 /repo"'];
  for (let i = 0; i < 600; i++) {
    lines.push(`echo " ✓ src/mod-${i % 40}.test.ts > case ${i} ${1 + (i % 9)}ms"`);
    if (i % 60 === 0) lines.push(`echo "npm warn deprecated inflight@1.0.6: unmaintained"`);
    if (i % 75 === 0) lines.push(`echo "  [${Math.floor((i / 600) * 100)}%] running…"`);
  }
  lines.push(
    'echo " ❯ src/checkout/total.test.ts (2 failed)"',
    'echo "   ✗ applies the loyalty discount"',
    'echo "     AssertionError: expected 1170 to be 1080"',
    'echo "      at src/checkout/total.ts:42:11"',
    'echo "      at src/checkout/total.test.ts:88:5"',
    'echo "   ✗ rejects a negative quantity"',
    'echo "     Error: quantity must be positive"',
    'echo "      at src/checkout/total.ts:17:5"',
    'echo ""',
    'echo " Test Files  1 failed | 40 passed (41)"',
    'echo "      Tests  2 failed | 600 passed (602)"',
    'echo "   Duration  9.81s"',
    "exit 1",
  );
  const path = join(dir, "run-tests.sh");
  await writeFile(path, lines.join("\n"));
  await chmod(path, 0o755);

  // The source the failures point at, so a fix has somewhere to land.
  await mkdir(join(dir, "src", "checkout"), { recursive: true });
  await writeFile(
    join(dir, "src", "checkout", "total.ts"),
    [
      "export interface Order { subtotal: number; loyaltyTier: string; quantity: number }",
      "",
      "export function computeTotal(order: Order): number {",
      "  if (order.quantity <= 0) throw new Error('quantity must be positive');",
      "  const discount = order.loyaltyTier === 'gold' ? 0.1 : 0;",
      "  // BUG: the discount is applied to the tax, not the subtotal.",
      "  return order.subtotal * (1 + 0.08 * (1 - discount));",
      "}",
    ].join("\n"),
  );
}

async function writeLogFixture(dir: string): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) {
    const ts = `2026-08-04T0${Math.floor(i / 1000)}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    if (i === 2317) {
      lines.push(`${ts} ERROR upstream timeout contacting settlement-service after 30000ms`);
      continue;
    }
    lines.push(`${ts} INFO processed batch ${i} in ${10 + (i % 40)}ms`);
  }
  await writeFile(join(dir, "server.log"), lines.join("\n"));
}

async function writeGrepFixture(dir: string): Promise<void> {
  for (let f = 0; f < 40; f++) {
    const moduleDir = join(dir, "src", `module-${f}`);
    await mkdir(moduleDir, { recursive: true });
    const occurrences = f < 3 ? 12 - f : 2;
    const body = Array.from(
      { length: occurrences },
      (_, i) => `export const use${i} = (order: unknown) => computeTotal(order as never); // ${i}`,
    );
    await writeFile(join(moduleDir, "handler.ts"), [`import { computeTotal } from "../checkout/total.js";`, ...body].join("\n"));
  }
}

export async function createFixture(dir: string, task: TaskId): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (task === "large-json" || task === "repeated-json" || task === "retrieval-required") {
    await writeJsonFixture(dir);
    return;
  }
  if (task === "test-failure" || task === "multi-file-bug") {
    await writeTestFixture(dir);
    return;
  }
  if (task === "large-log") {
    await writeLogFixture(dir);
    return;
  }
  await writeGrepFixture(dir);
  await mkdir(join(dir, "src", "checkout"), { recursive: true });
  await writeFile(join(dir, "src", "checkout", "total.ts"), "export function computeTotal(o: unknown) { return o; }\n");
}

/** The expected answer, for scoring task success without a human in the loop. */
export const TASK_ORACLE: Record<TaskId, (answer: string) => boolean> = {
  "large-json": (a) => /\b532\b/.test(a) && /connection reset by peer/i.test(a),
  "repeated-json": (a) => /\b800\b/.test(a) && /\b532\b/.test(a),
  "test-failure": (a) =>
    /loyalty discount/i.test(a) && /negative quantity/i.test(a) && /total\.ts:42/.test(a) && /total\.ts:17/.test(a),
  "large-log": (a) => /upstream timeout/i.test(a) && /2026-08-04T0\d:\d\d:\d\dZ/.test(a),
  // module-0/1/2 have 12/11/10 occurrences by construction; every other module has 2.
  "grep-exploration": (a) => /module-0\b/.test(a) && /module-1\b/.test(a) && /module-2\b/.test(a),
  // Record id 618 → index 617: checked_at 2026-08-06T07:17:00Z, region eu-west-1.
  // (Verified against the generator, not assumed — the first draft had the wrong date.)
  "retrieval-required": (a) => /2026-08-06T07:17:00Z/.test(a) && /eu-west-1/.test(a),
  "multi-file-bug": (a) => /total\.ts/.test(a) && /(42|subtotal)/.test(a),
};

if (process.argv[1]?.endsWith("fixtures.mts")) {
  const dir = process.argv[2];
  const task = (process.argv[3] ?? "large-json") as TaskId;
  if (!dir) {
    console.error("usage: fixtures.mts <dir> [task]");
    process.exit(2);
  }
  await createFixture(dir, task);
  console.log(`fixture ready: ${dir} (${task})`);
  // Print the oracle answer for retrieval-required so the fixture stays self-documenting.
  if (task === "retrieval-required") {
    const rec = records(800, 531)[617] as { checked_at: string; region: string };
    console.log(`oracle: checked_at=${rec.checked_at} region=${rec.region}`);
  }
}
