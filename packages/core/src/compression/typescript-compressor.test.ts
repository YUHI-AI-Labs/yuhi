import { describe, expect, it } from "vitest";
import { JavaScriptCompressor, TypeScriptCompressor } from "./typescript-compressor.js";
import { compressionHeader } from "./types.js";
import type { CompressionResult, ExtractedSymbol } from "./types.js";

const ts = new TypeScriptCompressor();
const js = new JavaScriptCompressor();

async function compressTs(relpath: string, content: string): Promise<CompressionResult> {
  return ts.compress({ relpath, content });
}

/** Flatten a symbol tree to a list of "kind:name" strings for easy assertions. */
function flatten(symbols: ExtractedSymbol[]): string[] {
  const out: string[] = [];
  const walk = (list: ExtractedSymbol[]) => {
    for (const symbol of list) {
      out.push(`${symbol.kind}:${symbol.name}`);
      if (symbol.children) walk(symbol.children);
    }
  };
  walk(symbols);
  return out;
}

function findSymbol(
  symbols: ExtractedSymbol[],
  predicate: (s: ExtractedSymbol) => boolean,
): ExtractedSymbol | undefined {
  for (const symbol of symbols) {
    if (predicate(symbol)) return symbol;
    if (symbol.children) {
      const nested = findSymbol(symbol.children, predicate);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe("supports()", () => {
  it("accepts the TypeScript extensions but not .d.ts declarations", () => {
    for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts"]) {
      expect(ts.supports(path, "")).toBe(true);
    }
    expect(ts.supports("a.d.ts", "")).toBe(false);
    expect(ts.supports("a.d.mts", "")).toBe(false);
    expect(ts.supports("a.js", "")).toBe(false);
  });

  it("JavaScriptCompressor accepts the JS extensions", () => {
    for (const path of ["a.js", "a.jsx", "a.mjs", "a.cjs"]) {
      expect(js.supports(path, "")).toBe(true);
    }
    expect(js.supports("a.ts", "")).toBe(false);
  });
});

describe("function compression", () => {
  it("drops a function body but keeps the signature and return type", async () => {
    const src = [
      "export function add(a: number, b: number): number {",
      "  // a body large enough that omitting it beats the compression header cost",
      "  const SECRET_BODY_MARKER = a + b;",
      "  const doubled = SECRET_BODY_MARKER * 2;",
      "  const tripled = SECRET_BODY_MARKER * 3;",
      "  const combined = doubled + tripled + SECRET_BODY_MARKER;",
      "  return combined - SECRET_BODY_MARKER;",
      "}",
    ].join("\n");
    const result = await compressTs("add.ts", src);

    expect(result.representation).toBe("compressed");
    expect(result.content.startsWith(compressionHeader("add.ts"))).toBe(true);
    expect(result.content).toContain("export function add(a: number, b: number): number");
    expect(result.content).toContain("{ /* ... */ }");
    // The body statement must be gone.
    expect(result.content).not.toContain("SECRET_BODY_MARKER");
    expect(result.compressedTokens).toBeLessThan(result.originalTokens);

    const fn = findSymbol(result.symbols, (s) => s.name === "add");
    expect(fn?.kind).toBe("function");
    expect(fn?.exported).toBe(true);
  });

  it("keeps async and preserves the return type", async () => {
    const src = [
      "export async function load(): Promise<string> {",
      "  return await fetchInner();",
      "}",
    ].join("\n");
    const result = await compressTs("load.ts", src);
    expect(result.content).toContain("export async function load(): Promise<string>");
    expect(result.content).not.toContain("fetchInner");
  });

  it("keeps overload signatures and drops only the implementation body", async () => {
    const src = [
      "export function pick(x: string): string;",
      "export function pick(x: number): number;",
      "export function pick(x: unknown): unknown {",
      "  return IMPLEMENTATION_ONLY;",
      "}",
    ].join("\n");
    const result = await compressTs("pick.ts", src);
    expect(result.content).toContain("export function pick(x: string): string;");
    expect(result.content).toContain("export function pick(x: number): number;");
    expect(result.content).not.toContain("IMPLEMENTATION_ONLY");
  });
});

describe("class compression", () => {
  const src = [
    "/** A widget. */",
    "@Component({ selector: 'w' })",
    "export abstract class Widget<T> extends Base<T> implements Renderable {",
    "  static readonly KIND = 'widget';",
    "  private hidden = 0;",
    "  public label: string;",
    "  constructor(label: string) {",
    "    super();",
    "    this.label = CONSTRUCTOR_BODY;",
    "  }",
    "  @log()",
    "  render(x: number): string {",
    "    return METHOD_BODY_TEXT;",
    "  }",
    "  get name(): string {",
    "    return GETTER_BODY;",
    "  }",
    "  abstract paint(): void;",
    "}",
  ].join("\n");

  it("keeps the public API, modifiers, inheritance, generics and decorators", async () => {
    const result = await compressTs("widget.ts", src);
    expect(result.representation).toBe("compressed");
    const out = result.content;

    expect(out).toContain("/** A widget. */");
    expect(out).toContain("@Component({ selector: 'w' })");
    expect(out).toContain(
      "export abstract class Widget<T> extends Base<T> implements Renderable",
    );
    expect(out).toContain("static readonly KIND = 'widget'");
    expect(out).toContain("public label: string");
    expect(out).toContain("@log()");
    expect(out).toContain("render(x: number): string");
    expect(out).toContain("get name(): string");
    expect(out).toContain("abstract paint(): void;");

    // All bodies dropped.
    expect(out).not.toContain("CONSTRUCTOR_BODY");
    expect(out).not.toContain("METHOD_BODY_TEXT");
    expect(out).not.toContain("GETTER_BODY");
    expect(out).not.toContain("super()");
  });

  it("extracts nested members under the class children", async () => {
    const result = await compressTs("widget.ts", src);
    const cls = findSymbol(result.symbols, (s) => s.kind === "class");
    expect(cls?.name).toBe("Widget");
    expect(cls?.exported).toBe(true);

    const flat = flatten(result.symbols);
    expect(flat).toContain("class:Widget");
    expect(flat).toContain("constructor:constructor");
    expect(flat).toContain("method:render");
    expect(flat).toContain("field:label");
    expect(flat).toContain("field:KIND");
    expect(flat).toContain("decorator:Component({ selector: 'w' })");

    // A private member is marked non-exported.
    const hidden = findSymbol(result.symbols, (s) => s.name === "hidden");
    expect(hidden?.exported).toBe(false);
    const label = findSymbol(result.symbols, (s) => s.name === "label");
    expect(label?.exported).toBe(true);
  });
});

describe("other declarations", () => {
  it("keeps interfaces, type aliases and enums intact", async () => {
    const src = [
      "export interface Point<T = number> { x: T; y: T; distance(): number; }",
      "export type ID = string | number;",
      "export enum Color { Red, Green, Blue }",
    ].join("\n");
    const result = await compressTs("model.ts", src);
    const out = result.content;
    expect(out).toContain("export interface Point<T = number>");
    expect(out).toContain("distance(): number;");
    expect(out).toContain("export type ID = string | number;");
    expect(out).toContain("export enum Color { Red, Green, Blue }");

    const flat = flatten(result.symbols);
    expect(flat).toContain("interface:Point");
    expect(flat).toContain("type:ID");
    expect(flat).toContain("enum:Color");
  });

  it("keeps imports and re-exports", async () => {
    const src = [
      "import { readFile } from 'node:fs/promises';",
      "import type { Stats } from 'node:fs';",
      "export { readFile };",
      "export * from './helpers.js';",
      "export function use(): void { return USE_BODY; }",
    ].join("\n");
    const result = await compressTs("io.ts", src);
    const out = result.content;
    expect(out).toContain("import { readFile } from 'node:fs/promises';");
    expect(out).toContain("import type { Stats } from 'node:fs';");
    expect(out).toContain("export { readFile };");
    expect(out).toContain("export * from './helpers.js';");
    expect(out).not.toContain("USE_BODY");

    const flat = flatten(result.symbols);
    expect(flat).toContain("import:node:fs/promises");
    expect(flat).toContain("export:./helpers.js");
  });

  it("keeps namespaces and compresses their nested functions", async () => {
    const src = [
      "export namespace Geo {",
      "  export function area(r: number): number {",
      "    return NAMESPACE_BODY;",
      "  }",
      "}",
    ].join("\n");
    const result = await compressTs("geo.ts", src);
    expect(result.content).toContain("export namespace Geo");
    expect(result.content).toContain("export function area(r: number): number");
    expect(result.content).not.toContain("NAMESPACE_BODY");

    const ns = findSymbol(result.symbols, (s) => s.kind === "namespace");
    expect(ns?.name).toBe("Geo");
    expect(flatten(result.symbols)).toContain("function:area");
  });
});

describe("comments and formatting", () => {
  it("preserves doc comments on kept declarations and drops in-body comments", async () => {
    const src = [
      "/**",
      " * Computes a thing.",
      " * @param n the input",
      " */",
      "export function compute(n: number): number {",
      "  // internal note that should disappear",
      "  return BODY_ONLY;",
      "}",
    ].join("\n");
    const result = await compressTs("doc.ts", src);
    expect(result.content).toContain("Computes a thing.");
    expect(result.content).toContain("@param n the input");
    expect(result.content).not.toContain("internal note that should disappear");
    expect(result.content).not.toContain("BODY_ONLY");
  });

  it("handles a multi-line signature", async () => {
    const src = [
      "export function big(",
      "  first: string,",
      "  second: number,",
      "  third: boolean,",
      "): void {",
      "  return MULTILINE_BODY;",
      "}",
    ].join("\n");
    const result = await compressTs("big.ts", src);
    // The multi-line signature text (original layout) is retained verbatim.
    expect(result.content).toContain("export function big(");
    expect(result.content).toContain("  third: boolean,");
    expect(result.content).not.toContain("MULTILINE_BODY");

    // The extracted signature is normalized to one line.
    const fn = findSymbol(result.symbols, (s) => s.name === "big");
    expect(fn?.signature).toBe(
      "export function big( first: string, second: number, third: boolean, ): void",
    );
  });

  it("preserves unicode and Japanese comments", async () => {
    const src = [
      "/** 面積を計算する関数 — μmeters² 🌸 */",
      "export function 面積(半径: number): number {",
      "  return 日本語ボディ;",
      "}",
    ].join("\n");
    const result = await compressTs("jp.ts", src);
    expect(result.content).toContain("面積を計算する関数 — μmeters² 🌸");
    expect(result.content).toContain("export function 面積(半径: number): number");
    expect(result.content).not.toContain("日本語ボディ");
  });
});

describe("safety and robustness", () => {
  it("does not treat pseudo-declarations inside strings or comments as symbols", async () => {
    const src = [
      "// export function ghostComment(): void { return 1; }",
      "export const template = `",
      "  export class GhostClass { ghostMethod() { return 2; } }",
      "  function ghostFn() {}",
      "`;",
      "export function real(): number { return REAL_BODY; }",
    ].join("\n");
    const result = await compressTs("ghost.ts", src);

    const flat = flatten(result.symbols);
    expect(flat).toContain("function:real");
    expect(flat).toContain("constant:template");
    // Nothing from inside the string / comment leaked into the symbol table.
    expect(flat.some((s) => s.toLowerCase().includes("ghost"))).toBe(false);
    // The string literal content is preserved verbatim (not compressed as code).
    expect(result.content).toContain("export class GhostClass { ghostMethod()");
  });

  it("keeps the file FULL on a syntax error", async () => {
    const src = "export function broken( { const 1 === : return";
    const result = await compressTs("broken.ts", src);
    expect(result.representation).toBe("full");
    expect(result.content).toBe(src);
    expect(result.originalTokens).toBe(result.compressedTokens);
    expect(result.warnings.map((w) => w.code)).toContain("parse-failed");
  });

  it("keeps an empty file FULL (nothing to compress)", async () => {
    const result = await compressTs("empty.ts", "");
    expect(result.representation).toBe("full");
    expect(result.content).toBe("");
  });

  it("compresses .tsx with JSX in a body", async () => {
    const src = [
      "export function View(): JSX.Element {",
      "  return <div className='JSX_BODY_MARKER'>hi</div>;",
      "}",
    ].join("\n");
    const result = await ts.compress({ relpath: "View.tsx", content: src });
    expect(result.representation).toBe("compressed");
    expect(result.content).toContain("export function View(): JSX.Element");
    expect(result.content).not.toContain("JSX_BODY_MARKER");
  });

  it("compresses plain JavaScript via JavaScriptCompressor", async () => {
    const src = [
      "export class Counter {",
      "  constructor() { this.n = JS_CTOR_BODY; }",
      "  inc() { return JS_METHOD_BODY; }",
      "}",
    ].join("\n");
    const result = await js.compress({ relpath: "counter.js", content: src });
    expect(result.representation).toBe("compressed");
    expect(result.content).toContain("export class Counter");
    expect(result.content).toContain("inc()");
    expect(result.content).not.toContain("JS_CTOR_BODY");
    expect(result.content).not.toContain("JS_METHOD_BODY");
  });
});

describe("determinism", () => {
  it("produces byte-identical output across repeated runs", async () => {
    const src = [
      "/** doc */",
      "export class A<T> extends B implements C {",
      "  @dec() method(x: T): T { return DETERMINISM_BODY; }",
      "  field = 1;",
      "}",
      "export function f(): void { return 0; }",
    ].join("\n");
    const a = await compressTs("d.ts", src);
    const b = await compressTs("d.ts", src);
    expect(a.content).toBe(b.content);
    expect(a.compressedTokens).toBe(b.compressedTokens);
    expect(JSON.stringify(a.symbols)).toBe(JSON.stringify(b.symbols));
  });
});
