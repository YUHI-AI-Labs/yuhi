import { describe, expect, it } from "vitest";
import { buildRepositoryMap, type RepositoryMapFile } from "./repository-map.js";
import { estimateTokens } from "./registry.js";

function shuffle<T>(list: readonly T[], seed: number): T[] {
  // Deterministic Fisher-Yates so the "shuffled input" test is reproducible.
  const arr = [...list];
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

describe("buildRepositoryMap", () => {
  it("extracts a class and its method into the map", () => {
    const files: RepositoryMapFile[] = [
      {
        relpath: "src/core/scanner.ts",
        symbols: [
          {
            kind: "class",
            name: "RepositoryScanner",
            exported: true,
            line: 10,
            children: [
              {
                kind: "method",
                name: "scan",
                signature: "scan(): Promise<ScanResult>",
                line: 12,
              },
            ],
          },
        ],
      },
    ];
    const map = buildRepositoryMap(files);
    expect(map.text).toContain("src/");
    expect(map.text).toContain("core/");
    expect(map.text).toContain("scanner.ts");
    expect(map.text).toContain("class RepositoryScanner");
    expect(map.text).toContain("scan(): Promise<ScanResult>");
    expect(map.tokens).toBe(estimateTokens(map.text));
    expect(map.truncated).toBe(false);
    expect(map.omittedFiles).toBe(0);
  });

  it("marks and lists entry points", () => {
    const files: RepositoryMapFile[] = [
      { relpath: "src/index.ts", isEntryPoint: true, symbols: [] },
      { relpath: "src/util.ts", symbols: [] },
    ];
    const map = buildRepositoryMap(files);
    expect(map.entryPoints).toEqual(["src/index.ts"]);
    expect(map.text).toContain("index.ts (entry point)");
    expect(map.text).toContain("## Entry points");
    expect(map.text).toContain("  src/index.ts");
    // Non-entry files are not marked.
    expect(map.text).toContain("util.ts");
    expect(map.text).not.toContain("util.ts (entry point)");
  });

  it("produces intra-repo import edges and drops external imports", () => {
    const files: RepositoryMapFile[] = [
      {
        relpath: "src/a.ts",
        imports: ["./b.js", "react", "@yuhi/shared", "./missing.js"],
        symbols: [],
      },
      { relpath: "src/b.ts", symbols: [] },
    ];
    const map = buildRepositoryMap(files);
    expect(map.importEdges).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);
    expect(map.text).toContain("src/a.ts -> src/b.ts");
    // External and unresolved imports never appear.
    expect(map.text).not.toContain("react");
    expect(map.text).not.toContain("@yuhi/shared");
    expect(map.text).not.toContain("missing");
  });

  it("resolves a directory index import", () => {
    const files: RepositoryMapFile[] = [
      { relpath: "src/main.ts", imports: ["./core"], symbols: [] },
      { relpath: "src/core/index.ts", symbols: [] },
    ];
    const map = buildRepositoryMap(files);
    expect(map.importEdges).toEqual([{ from: "src/main.ts", to: "src/core/index.ts" }]);
  });

  it("is deterministic: same input builds identical text twice", () => {
    const files: RepositoryMapFile[] = [
      {
        relpath: "src/core/scanner.ts",
        imports: ["./types.js"],
        symbols: [{ kind: "class", name: "Scanner", exported: true, line: 3 }],
      },
      { relpath: "src/core/types.ts", symbols: [{ kind: "type", name: "T", line: 1 }] },
      { relpath: "src/index.ts", isEntryPoint: true, symbols: [] },
    ];
    const a = buildRepositoryMap(files);
    const b = buildRepositoryMap(files);
    expect(a.text).toBe(b.text);
  });

  it("is order-independent: shuffled input yields identical output", () => {
    const files: RepositoryMapFile[] = [
      { relpath: "src/z.ts", symbols: [{ kind: "function", name: "z", line: 1 }] },
      { relpath: "src/a.ts", imports: ["./z.js"], symbols: [] },
      { relpath: "src/index.ts", isEntryPoint: true, imports: ["./a.js"], symbols: [] },
      { relpath: "src/nested/deep/thing.ts", symbols: [{ kind: "class", name: "Thing", line: 2 }] },
    ];
    const base = buildRepositoryMap(files);
    for (const seed of [1, 7, 42, 999]) {
      const map = buildRepositoryMap(shuffle(files, seed));
      expect(map.text).toBe(base.text);
      expect(map.importEdges).toEqual(base.importEdges);
      expect(map.entryPoints).toEqual(base.entryPoints);
    }
  });

  it("trims to the token budget, records truncation and omitted files", () => {
    const files: RepositoryMapFile[] = [];
    for (let i = 0; i < 200; i++) {
      const dir = `pkg${i % 8}/sub${i % 4}`;
      files.push({
        relpath: `${dir}/file${i}.ts`,
        isEntryPoint: i === 0,
        symbols: [
          {
            kind: "class",
            name: `LongClassName${i}`,
            exported: i % 3 === 0,
            line: 1,
            signature: `class LongClassName${i} extends SomeVeryLongBaseClass${i}`,
            children: [
              { kind: "method", name: `methodOne${i}`, signature: `methodOne${i}(): void`, line: 2 },
              { kind: "method", name: `methodTwo${i}`, signature: `methodTwo${i}(): number`, line: 3 },
            ],
          },
        ],
      });
    }
    const budget = 400;
    const map = buildRepositoryMap(files, { tokenBudget: budget });
    expect(map.truncated).toBe(true);
    expect(map.omittedFiles).toBeGreaterThan(0);
    expect(map.tokens).toBeLessThanOrEqual(budget);
    // Highest-importance file (the entry point) survives trimming.
    expect(map.text).toContain("file0.ts");
    expect(map.entryPoints).toContain("pkg0/sub0/file0.ts");
  });

  it("does not trim when everything fits the budget", () => {
    const files: RepositoryMapFile[] = [
      { relpath: "src/a.ts", symbols: [{ kind: "function", name: "a", line: 1 }] },
    ];
    const map = buildRepositoryMap(files, { tokenBudget: 5000 });
    expect(map.truncated).toBe(false);
    expect(map.omittedFiles).toBe(0);
  });

  it("normalizes Windows path separators to POSIX", () => {
    const files: RepositoryMapFile[] = [
      {
        relpath: "src\\core\\scanner.ts",
        imports: ["..\\util\\log.js"],
        symbols: [{ kind: "class", name: "S", line: 1 }],
      },
      { relpath: "src\\util\\log.ts", symbols: [] },
    ];
    const map = buildRepositoryMap(files);
    expect(map.text).toContain("scanner.ts");
    expect(map.text).not.toContain("\\");
    expect(map.importEdges).toEqual([{ from: "src/core/scanner.ts", to: "src/util/log.ts" }]);
  });

  it("skips empty / symlink-like relpaths without crashing", () => {
    const files: RepositoryMapFile[] = [
      { relpath: "", symbols: [] },
      { relpath: "   ", symbols: [] },
      { relpath: ".", symbols: [] },
      // @ts-expect-error — exercise a malformed relpath at runtime.
      { relpath: undefined, symbols: [] },
      { relpath: "src/real.ts", symbols: [{ kind: "function", name: "real", line: 1 }] },
    ];
    const map = buildRepositoryMap(files);
    expect(map.text).toContain("real.ts");
    // Only the one valid file made it in.
    expect(map.text.match(/\.ts/g)?.length).toBe(1);
  });
});
