import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareWorkspace } from "./prepare-workspace.js";
import { estimateTokens } from "./compression/index.js";

let dir: string;
let managedDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-compress-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-managed-"));
  process.env.YUHI_HOME = managedDir;
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** SHA-256 of every source file, so we can prove the SOURCE tree is byte-identical after. */
function hashSourceTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else hashes.set(path.relative(root, abs), createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return hashes;
}

/** A large TS module: a real signature to keep, a unique body marker to drop, and filler. */
const BODY_MARKER = "UNIQUE_OMITTED_BODY_MARKER_ZZZ";
function bigTsSource(): string {
  const parts: string[] = [
    "export interface Widget { id: number; label: string; }",
    "",
    "export function computeWidgetScore(input: number[]): number {",
    `  const ${BODY_MARKER} = 42;`,
    "  let total = 0;",
    `  for (const value of input) { total += value * ${BODY_MARKER}; }`,
    "  return total;",
    "}",
    "",
  ];
  for (let i = 0; i < 120; i += 1) {
    parts.push(
      `export function filler${i}(a: number, b: number): number {`,
      `  const scratch = a * ${i} + b - ${i};`,
      "  let acc = 0;",
      `  for (let k = 0; k < ${i + 3}; k += 1) { acc += scratch + k; }`,
      "  return acc + scratch;",
      "}",
      "",
    );
  }
  return parts.join("\n");
}

const YUHI_CONFIG = 'version: "1"\nrules: []\n';

describe("v0.3.3 structure compression integration", () => {
  it("threads a 5000 token budget through Prepare into the shared public summary", async () => {
    put("yuhi.yaml", YUHI_CONFIG);
    put("src/index.ts", "export const start = (): void => {};\n");
    put("src/feature.ts", bigTsSource());
    put("package.json", JSON.stringify({ name: "budget-e2e", version: "1.0.0" }) + "\n");

    const report = await prepareWorkspace(dir, { compress: true, tokenBudget: 5_000 });
    expect(report.compression).toBeDefined();
    expect(report.compression?.targetBudget).toBe(5_000);
    expect(report.compression?.preparedTokens).toBeGreaterThan(0);
    expect(report.publicSummary?.compressionEnabled).toBe(true);
    expect(report.publicSummary?.tokenBudget).toBe(5_000);
    expect(["achieved", "best-effort-over-target"]).toContain(
      report.publicSummary?.tokenBudgetStatus,
    );
  });

  it("body-omits a large TS file, keeps manifests/README full, and never touches source", async () => {
    put("yuhi.yaml", YUHI_CONFIG);
    put("src/big.ts", bigTsSource());
    put("package.json", JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2) + "\n");
    put("README.md", "# Demo project\n\nA small synthetic project.\n");
    put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2) + "\n");

    const sourceBefore = hashSourceTree(dir);
    const sourceBigTs = readFileSync(path.join(dir, "src/big.ts"), "utf8");

    const report = await prepareWorkspace(dir, { compress: true });

    // SOURCE is byte-identical after the run.
    const sourceAfter = hashSourceTree(dir);
    expect([...sourceAfter.entries()].sort()).toEqual([...sourceBefore.entries()].sort());

    // The delivered TS file is body-omitted: signature stays, body marker is gone.
    const deliveredBigTs = readFileSync(path.join(report.outDir, "src/big.ts"), "utf8");
    expect(deliveredBigTs).toContain("computeWidgetScore(input: number[]): number");
    expect(deliveredBigTs).not.toContain(BODY_MARKER);
    expect(estimateTokens(deliveredBigTs)).toBeLessThan(estimateTokens(sourceBigTs));

    // package.json and README stay FULL and unchanged on disk.
    expect(readFileSync(path.join(report.outDir, "package.json"), "utf8")).toBe(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    expect(readFileSync(path.join(report.outDir, "README.md"), "utf8")).toBe(
      readFileSync(path.join(dir, "README.md"), "utf8"),
    );

    // Report compression summary is present and internally consistent.
    expect(report.compression).toBeDefined();
    const summary = report.compression!;
    expect(summary.compressedFiles).toBeGreaterThanOrEqual(1);
    expect(summary.preparedTokens).toBeLessThan(summary.originalTokens);
    expect(summary.status).toBe("no-budget");

    // Manifest carries per-file compression fields + the summary.
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.compression).toBeDefined();
    expect(manifest.compression.compressedFiles).toBe(summary.compressedFiles);
    const mBig = manifest.files.find((f: { relpath: string }) => f.relpath === "src/big.ts");
    expect(mBig.contextRepresentation).toBe("compressed");
    expect(mBig.compressionReason).toBe("structural-compression");
    expect(mBig.originalTokens).toBeGreaterThan(mBig.preparedTokens);
    const mPkg = manifest.files.find((f: { relpath: string }) => f.relpath === "package.json");
    expect(mPkg.contextRepresentation).toBe("full");
    expect(mPkg.compressionReason).toBe("package-manifest");
    const mReadme = manifest.files.find((f: { relpath: string }) => f.relpath === "README.md");
    expect(mReadme.contextRepresentation).toBe("full");
    expect(mReadme.compressionReason).toBe("too-small");
  });

  it("a small token budget excludes a non-essential source file (reason 'budget') but never a MustKeep file", async () => {
    put("yuhi.yaml", YUHI_CONFIG);
    put("src/index.ts", "export const start = (): void => {};\n"); // entry point → MustKeep
    put("src/feature.ts", bigTsSource()); // non-MustKeep, compressible → drop candidate
    put("package.json", JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2) + "\n");
    put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2) + "\n");

    const report = await prepareWorkspace(dir, { compress: true, tokenBudget: 10 });
    const summary = report.compression!;
    const feature = summary.files.find((f) => f.relpath === "src/feature.ts");
    expect(feature?.representation).toBe("excluded");
    expect(feature?.reason).toBe("token-budget");
    // Excluded delivered copy is removed; source is untouched.
    expect(existsSync(path.join(report.outDir, "src/feature.ts"))).toBe(false);
    expect(existsSync(path.join(dir, "src/feature.ts"))).toBe(true);

    // MustKeep files were NOT excluded.
    for (const rel of ["src/index.ts", "package.json", "tsconfig.json"]) {
      const decision = summary.files.find((f) => f.relpath === rel);
      expect(decision?.representation).not.toBe("excluded");
      expect(existsSync(path.join(report.outDir, rel))).toBe(true);
    }
  });

  it("a syntactically broken TS file stays FULL (parse-failed) and the run still succeeds", async () => {
    put("yuhi.yaml", YUHI_CONFIG);
    put("src/broken.ts", "export function broken( { : : : }}} const = = ;\n");

    const report = await prepareWorkspace(dir, { compress: true });
    const broken = report.compression!.files.find((f) => f.relpath === "src/broken.ts");
    expect(broken?.representation).toBe("full");
    expect(broken?.reason).toBe("parse-failed");
    // Delivered file is the original, unchanged.
    expect(readFileSync(path.join(report.outDir, "src/broken.ts"), "utf8")).toBe(
      readFileSync(path.join(dir, "src/broken.ts"), "utf8"),
    );
  });

  it("compress:false adds no compression fields (identical to today)", async () => {
    put("yuhi.yaml", YUHI_CONFIG);
    put("src/big.ts", bigTsSource());
    put("package.json", JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2) + "\n");

    const report = await prepareWorkspace(dir);
    expect(report.compression).toBeUndefined();
    for (const file of report.files) {
      expect(file.contextRepresentation).toBeUndefined();
      expect(file.compressionReason).toBeUndefined();
      expect(file.originalTokens).toBeUndefined();
      expect(file.preparedTokens).toBeUndefined();
    }
    // The delivered TS file is the verbatim source (no body omission).
    const deliveredBigTs = readFileSync(path.join(report.outDir, "src/big.ts"), "utf8");
    expect(deliveredBigTs).toContain(BODY_MARKER);
    const manifest = JSON.parse(readFileSync(path.join(report.outDir, "manifest.json"), "utf8"));
    expect(manifest.compression).toBeUndefined();
  });
});
