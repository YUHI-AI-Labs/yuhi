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
  | "multi-file-bug"
  | "mixed-dev"
  | "large-log-read"
  // v0.5.0 additions (docs/design/0.5.0_benchmark.md §3), mapped to fixtures the
  // v0.4.0 set did not already cover:
  | "existing-helper-reuse"
  | "small-bug"
  | "repeated-command"
  | "broad-refactor"
  | "document-analysis";

export const TASK_PROMPTS: Record<TaskId, string> = {
  "large-json":
    "Read data.json. Find the single record whose status is not ok, report its id and the error message, and say nothing else.",
  "repeated-json":
    "Read data.json and report how many records it holds. Then consult data.json again and report the id of the record whose status is not ok. Report both numbers and nothing else.",
  "test-failure":
    "Run `bash run-tests.sh`. Report the name of each failing test, its assertion message, and the source file and line each failure points at. Do not fix anything.",
  // Natural phrasing: the agent decides how to look. Measured outcome — it greps, so a
  // large log never reaches the model and the compressor does not fire.
  "large-log":
    "Diagnose server.log. There are three error clusters; report the one that is NOT retryable, its timestamp, and the source file and line from its stack trace. Nothing else.",
  // Forced phrasing: the whole file becomes one tool result, so the compressor applies.
  // Kept as a separate task so the two behaviours are never conflated.
  "large-log-read":
    "Read the entire server.log file in one go, then report the error that is NOT retryable, its timestamp, and the source file and line from its stack trace. Nothing else.",
  "grep-exploration":
    "Run `grep -rn computeTotal src/` and, from that output, list the three files with the most occurrences, each with its count. Nothing else.",
  "retrieval-required":
    "Read data.json. Report the exact value of the `checked_at` field of the record whose id is 618, and its `region`. Report only those two values.",
  "multi-file-bug":
    "Run `bash run-tests.sh`, then report which source file and line must change to fix the failing test, and what the fix is. Do not edit any file.",
  "mixed-dev":
    "Run `bash run-tests.sh`. Diagnose the failing test, read the relevant source, apply the minimal fix, then run `bash run-tests.sh` again and report whether it passes.",
  "existing-helper-reuse":
    "We need to format a refund amount as currency in src/refunds/issue.ts. Look at src/lib/format.ts first, then say exactly which existing function you would call to do this and why you would not write a new one.",
  "small-bug":
    "src/lib/clamp.ts has exactly one bug. Read it and report the one-line fix, quoting the exact current line and the exact corrected line. Do not fix anything else.",
  "repeated-command":
    "Run `bash check.sh`. Its output can be flaky under load, so run it a second time to confirm the result is stable before reporting it. Report the final status only.",
  "broad-refactor":
    "The function `computeTotal` (src/checkout/total.ts) is imported under that name in every file under src/. Find every file that imports or calls it, and report the exact list of files. Do not rename anything yet — report list only.",
  "document-analysis":
    "Read INCIDENT_REPORT.md and report the root cause, the remediation owner, and the target remediation date. Nothing else.",
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
  const stamp = (i: number): string =>
    `2026-08-04T0${Math.floor(i / 1000)}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;

  for (let i = 0; i < 4000; i++) {
    // Three error clusters, each with a stack trace; one of them is the actionable one.
    if (i === 900 || i === 2317 || i === 3400) {
      const message =
        i === 2317
          ? "upstream timeout contacting settlement-service after 30000ms"
          : i === 900
            ? "retryable: connection reset by peer"
            : "retryable: socket hang up";
      lines.push(`${stamp(i)} ERROR ${message}`);
      lines.push(`${stamp(i)}     at SettlementClient.commit (src/settlement/client.ts:118:15)`);
      lines.push(`${stamp(i)}     at BatchWorker.run (src/worker/batch.ts:64:7)`);
      lines.push(`${stamp(i)}     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`);
      continue;
    }
    if (i % 250 === 0) lines.push(`${stamp(i)} WARN connection pool at 80% capacity`);
    // A synthetic credential in ordinary log noise: it must never reach the provider.
    if (i === 1500) {
      lines.push(`${stamp(i)} DEBUG auth refresh aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`);
      continue;
    }
    lines.push(`${stamp(i)} INFO processed batch ${i} in ${10 + (i % 40)}ms`);
  }
  await writeFile(join(dir, "server.log"), lines.join("\n"));
}

/** A real failing test that a real patch can make pass. */
async function writeMixedDevFixture(dir: string): Promise<void> {
  await writeFile(
    join(dir, "total.mjs"),
    [
      "export function computeTotal(order) {",
      "  if (order.quantity <= 0) throw new Error('quantity must be positive');",
      "  const discount = order.loyaltyTier === 'gold' ? 0.1 : 0;",
      "  // BUG: the discount is applied to the tax rate instead of the subtotal.",
      "  return Math.round(order.subtotal * (1 + 0.08 * (1 - discount)));",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "test.mjs"),
    [
      "import { computeTotal } from './total.mjs';",
      "let failed = 0;",
      "for (let i = 0; i < 600; i++) console.log(` ✓ case ${i} passed 1ms`);",
      "const got = computeTotal({ subtotal: 1000, loyaltyTier: 'gold', quantity: 1 });",
      "const want = 972; // 1000 * 0.9 * 1.08",
      "if (got !== want) {",
      "  failed++;",
      "  console.log('   ✗ applies the loyalty discount to the subtotal');",
      "  console.log(`     AssertionError: expected ${got} to be ${want}`);",
      "  console.log('      at total.mjs:5:10');",
      "}",
      "console.log(`      Tests  ${failed} failed | 600 passed (${600 + failed})`);",
      "process.exit(failed === 0 ? 0 : 1);",
    ].join("\n"),
  );
  const runner = join(dir, "run-tests.sh");
  await writeFile(runner, "#!/usr/bin/env bash\nnode test.mjs\n");
  await chmod(runner, 0o755);
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

/** An existing helper the agent should find and reuse rather than reimplement. */
async function writeHelperReuseFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "src", "lib"), { recursive: true });
  await mkdir(join(dir, "src", "refunds"), { recursive: true });
  await writeFile(
    join(dir, "src", "lib", "format.ts"),
    [
      "/** Formats a minor-unit integer amount as a localized currency string. */",
      "export function formatCurrencyMinorUnits(amountMinorUnits: number, currency: string): string {",
      "  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinorUnits / 100);",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "src", "refunds", "issue.ts"),
    [
      "export interface RefundRequest { amountMinorUnits: number; currency: string; orderId: string }",
      "",
      "export function issueRefund(request: RefundRequest): { orderId: string; amountMinorUnits: number } {",
      "  // TODO: format request.amountMinorUnits as currency for the confirmation email.",
      "  return { orderId: request.orderId, amountMinorUnits: request.amountMinorUnits };",
      "}",
    ].join("\n"),
  );
}

/** Exactly one bug, in a small, obviously-scoped file (Rule 3: small + load-bearing). */
async function writeSmallBugFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "src", "lib"), { recursive: true });
  await writeFile(
    join(dir, "src", "lib", "clamp.ts"),
    [
      "export function clamp(value: number, min: number, max: number): number {",
      "  // BUG: comparison operators are swapped, so this returns the wrong bound.",
      "  if (value < min) return max;",
      "  if (value > max) return min;",
      "  return value;",
      "}",
    ].join("\n"),
  );
}

/** A script whose result is stable, but the prompt asks for a confirming re-run
 *  (Phase 5's exact-command detection needs the SAME command to actually repeat). */
async function writeRepeatedCommandFixture(dir: string): Promise<void> {
  const path = join(dir, "check.sh");
  await writeFile(
    path,
    ["#!/usr/bin/env bash", 'echo "status: ok (checked 42 invariants)"', "exit 0"].join("\n"),
  );
  await chmod(path, 0o755);
}

/** `computeTotal` imported/called from many files — forces a wide read surface
 *  (Rule 6/8 budget pressure) without any single file being large. */
async function writeBroadRefactorFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "src", "checkout"), { recursive: true });
  await writeFile(
    join(dir, "src", "checkout", "total.ts"),
    "export function computeTotal(o: unknown) { return o; }\n",
  );
  const importingFiles = ["cart", "invoice", "receipt", "email", "admin-panel", "export-csv", "webhook", "audit-log"];
  for (const name of importingFiles) {
    await mkdir(join(dir, "src", name), { recursive: true });
    await writeFile(
      join(dir, "src", name, "index.ts"),
      [
        'import { computeTotal } from "../checkout/total.js";',
        `export function run${name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}(o: unknown) {`,
        "  return computeTotal(o);",
        "}",
      ].join("\n"),
    );
  }
}

/** A markdown "document" with a specific fact buried in prose (document-analysis intent). */
async function writeDocumentAnalysisFixture(dir: string): Promise<void> {
  const paragraphs = [
    "# Incident Report — Settlement Batch Delay",
    "",
    "## Summary",
    "",
    "On 2026-08-03 the nightly settlement batch completed 41 minutes late. Customer-facing",
    "impact was limited to a delayed balance update; no payments were lost or duplicated.",
    "",
    ...Array.from(
      { length: 60 },
      (_, i) => `Timeline note ${i}: monitoring showed nominal queue depth and no alerts fired during this window.`,
    ),
    "",
    "## Root Cause",
    "",
    "The batch worker's retry backoff was miscalculated after a dependency upgrade changed the",
    "default HTTP client timeout from 30s to 5s, causing the settlement-service client to retry",
    "far more aggressively than intended and exhaust its connection pool under normal load.",
    "",
    ...Array.from(
      { length: 40 },
      (_, i) => `Supporting detail ${i}: connection pool metrics from the affected window, included for completeness.`,
    ),
    "",
    "## Remediation",
    "",
    "Owner: Priya Nandakumar (Payments Platform). Target date: 2026-08-14. The fix pins the",
    "HTTP client timeout explicitly rather than inheriting the library default.",
  ];
  await writeFile(join(dir, "INCIDENT_REPORT.md"), paragraphs.join("\n"));
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
  if (task === "large-log" || task === "large-log-read") {
    await writeLogFixture(dir);
    return;
  }
  if (task === "mixed-dev") {
    await writeMixedDevFixture(dir);
    return;
  }
  if (task === "existing-helper-reuse") {
    await writeHelperReuseFixture(dir);
    return;
  }
  if (task === "small-bug") {
    await writeSmallBugFixture(dir);
    return;
  }
  if (task === "repeated-command") {
    await writeRepeatedCommandFixture(dir);
    return;
  }
  if (task === "broad-refactor") {
    await writeBroadRefactorFixture(dir);
    return;
  }
  if (task === "document-analysis") {
    await writeDocumentAnalysisFixture(dir);
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
  // The non-retryable cluster is the settlement timeout at index 2317, whose stack points
  // at src/settlement/client.ts:118.
  "large-log": (a) => /upstream timeout/i.test(a) && /client\.ts:118/.test(a),
  "large-log-read": (a) => /upstream timeout/i.test(a) && /client\.ts:118/.test(a),
  // module-0/1/2 have 12/11/10 occurrences by construction; every other module has 2.
  "grep-exploration": (a) => /module-0\b/.test(a) && /module-1\b/.test(a) && /module-2\b/.test(a),
  // Record id 618 → index 617: checked_at 2026-08-06T07:17:00Z, region eu-west-1.
  // (Verified against the generator, not assumed — the first draft had the wrong date.)
  "retrieval-required": (a) => /2026-08-06T07:17:00Z/.test(a) && /eu-west-1/.test(a),
  "multi-file-bug": (a) => /total\.ts/.test(a) && /(42|subtotal)/.test(a),
  // Scored by re-running the suite, not by the prose; the answer only has to claim it.
  "mixed-dev": (a) => /pass/i.test(a),
  "existing-helper-reuse": (a) => /formatCurrencyMinorUnits/.test(a),
  "small-bug": (a) => /return max/.test(a) && /return min/.test(a),
  // The correct final status is "ok" both times; the harness's OWN repeated-command
  // detection (not this oracle) is what the fixture is actually for — see
  // packages/context-runtime/src/planner/repeated-work.test.ts for the unit-level proof.
  "repeated-command": (a) => /ok/i.test(a),
  "broad-refactor": (a) =>
    ["cart", "invoice", "receipt", "email", "admin-panel", "export-csv", "webhook", "audit-log"].every((f) =>
      new RegExp(f).test(a),
    ),
  "document-analysis": (a) => /priya nandakumar/i.test(a) && /2026-08-14/.test(a) && /timeout/i.test(a),
};

/**
 * A file that must exist in the working directory for the run to be measuring THIS task.
 * The static conditions resolve a prepared workspace, and a resolution that silently
 * returned some other repository's workspace once produced a whole invalid condition —
 * so the harness now checks instead of assuming.
 */
export const FIXTURE_MARKER: Record<TaskId, string> = {
  "large-json": "data.json",
  "repeated-json": "data.json",
  "retrieval-required": "data.json",
  "test-failure": "run-tests.sh",
  "multi-file-bug": "run-tests.sh",
  "mixed-dev": "test.mjs",
  "large-log": "server.log",
  "large-log-read": "server.log",
  "grep-exploration": "src/checkout/total.ts",
  "existing-helper-reuse": "src/lib/format.ts",
  "small-bug": "src/lib/clamp.ts",
  "repeated-command": "check.sh",
  "broad-refactor": "src/checkout/total.ts",
  "document-analysis": "INCIDENT_REPORT.md",
};

/** Tasks whose success is decided by re-running the fixture's tests after the agent. */
export const PATCH_TASKS: readonly TaskId[] = ["mixed-dev"];

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
