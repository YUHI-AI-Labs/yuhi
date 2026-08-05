/**
 * v0.5.0 Phase 7 — the 5 new benchmark fixtures (docs/design/0.5.0_benchmark.md
 * §3) are real and runnable without a live model: this only proves the fixture
 * generator produces valid, self-consistent files and that each oracle correctly
 * scores its own fixture's known-correct answer. It does NOT run Claude --
 * see 0.5.0_benchmark.md §6 for why no live-run numbers exist in this repo.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixture, FIXTURE_MARKER, TASK_ORACLE, TASK_PROMPTS, type TaskId } from "../scripts/fixtures.mts";

const NEW_TASKS: readonly TaskId[] = [
  "existing-helper-reuse",
  "small-bug",
  "repeated-command",
  "broad-refactor",
  "document-analysis",
];

describe("v0.5.0 benchmark fixtures", () => {
  it.each(NEW_TASKS)("createFixture(%s) writes its own FIXTURE_MARKER file", async (task) => {
    const dir = await mkdtemp(join(tmpdir(), `yuhi-bench-fixture-${task}-`));
    await createFixture(dir, task);
    const marker = FIXTURE_MARKER[task];
    const content = await readFile(join(dir, marker), "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  it.each(NEW_TASKS)("every new task has a non-empty prompt", (task) => {
    expect(TASK_PROMPTS[task].length).toBeGreaterThan(10);
  });

  it("existing-helper-reuse: the oracle accepts an answer naming the existing helper", () => {
    expect(TASK_ORACLE["existing-helper-reuse"]("I would call formatCurrencyMinorUnits from src/lib/format.ts")).toBe(true);
    expect(TASK_ORACLE["existing-helper-reuse"]("I would write a new formatting function")).toBe(false);
  });

  it("small-bug: the fixture actually contains the swapped-comparison bug the oracle expects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-bench-fixture-small-bug-"));
    await createFixture(dir, "small-bug");
    const content = await readFile(join(dir, "src", "lib", "clamp.ts"), "utf8");
    expect(content).toContain("return max");
    expect(content).toContain("return min");
    expect(TASK_ORACLE["small-bug"]("Swap the branches: `if (value < min) return min;` and `if (value > max) return max;`")).toBe(true);
    expect(TASK_ORACLE["small-bug"]("Nothing needs to change")).toBe(false);
  });

  it("repeated-command: the script's own output is stable across repeated runs (the point of the fixture)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-bench-fixture-repeated-command-"));
    await createFixture(dir, "repeated-command");
    const { execFileSync } = await import("node:child_process");
    const first = execFileSync("bash", ["check.sh"], { cwd: dir, encoding: "utf8" });
    const second = execFileSync("bash", ["check.sh"], { cwd: dir, encoding: "utf8" });
    expect(first).toBe(second);
    expect(TASK_ORACLE["repeated-command"](first)).toBe(true);
  });

  it("broad-refactor: every claimed importing file actually imports computeTotal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-bench-fixture-broad-refactor-"));
    await createFixture(dir, "broad-refactor");
    const files = ["cart", "invoice", "receipt", "email", "admin-panel", "export-csv", "webhook", "audit-log"];
    for (const f of files) {
      const content = await readFile(join(dir, "src", f, "index.ts"), "utf8");
      expect(content).toContain("computeTotal");
    }
    const claimedAll = files.join(", ");
    expect(TASK_ORACLE["broad-refactor"](claimedAll)).toBe(true);
    expect(TASK_ORACLE["broad-refactor"]("only cart and invoice")).toBe(false);
  });

  it("document-analysis: the oracle's expected facts are actually present in the generated document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-bench-fixture-document-analysis-"));
    await createFixture(dir, "document-analysis");
    const content = await readFile(join(dir, "INCIDENT_REPORT.md"), "utf8");
    expect(content).toContain("Priya Nandakumar");
    expect(content).toContain("2026-08-14");
    expect(content.toLowerCase()).toContain("timeout");
    expect(
      TASK_ORACLE["document-analysis"](
        "Root cause: HTTP client timeout misconfiguration. Owner: Priya Nandakumar. Target date: 2026-08-14.",
      ),
    ).toBe(true);
  });
});
