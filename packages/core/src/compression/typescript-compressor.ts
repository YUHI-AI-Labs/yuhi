/**
 * TypeScript / JavaScript structure compressor (v0.3.3).
 *
 * Produces a deterministic, body-omitted, syntactically-recognizable view of a
 * source file: imports, exports, declarations, and signatures are kept (with their
 * leading doc comments); function / method / constructor / accessor bodies are
 * replaced by `{ /* ... *\/ }`. Everything is derived from the syntax tree only.
 *
 * Guarantees:
 *   - Deterministic: same input -> byte-identical output (source order, no clocks).
 *   - Never throws: any parse error or unexpected shape falls back to a FULL result
 *     with a recorded warning, so a file is never emptied or corrupted.
 *
 * Dependency isolation (v0.3.3): `typescript` is imported for TYPES ONLY at the top
 * level (erased at build) and loaded as a VALUE lazily, on first compression, via a
 * cached dynamic import. Importing this module — or a normal `yuhi prepare` that never
 * compresses — must not pull `typescript` into the bundle or execute it. When
 * `typescript` is not installed, `loadTs()` throws and `compress()` keeps the file FULL.
 */
import type * as ts from "typescript";
import { estimateTokens, fullResult } from "./registry.js";
import { compressionHeader } from "./types.js";
import type {
  CompressionInput,
  CompressionResult,
  ExtractedSymbol,
  SourceCompressor,
} from "./types.js";

/** The runtime `typescript` module (values only; TYPES come from `import type * as ts`). */
type TsModule = typeof import("typescript");

/**
 * Cached lazy loader for the `typescript` runtime. The top-level import above is a
 * TYPE-only import (erased at build), so `typescript` is neither bundled nor executed
 * until a file is actually compressed. Throws if `typescript` is not installed; the
 * caller (`compress()`) turns that into a safe FULL result.
 */
let tsRuntime: TsModule | undefined;
async function loadTs(): Promise<TsModule> {
  if (!tsRuntime) {
    const m = await import("typescript");
    tsRuntime = (m as { default?: TsModule }).default ?? m;
  }
  return tsRuntime;
}

/** The placeholder that replaces an omitted implementation body. Valid TypeScript. */
const OMITTED_BODY = "{ /* ... */ }";

/** Collapse all runs of whitespace to a single space and trim (for signatures). */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Lower-cased extension test that also rejects declaration files for TS. */
function matchesExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/** Shared implementation; `TypeScriptCompressor` / `JavaScriptCompressor` configure it. */
abstract class TsLikeCompressor implements SourceCompressor {
  abstract readonly languageId: string;
  protected abstract readonly extensions: readonly string[];

  supports(path: string, _content: string): boolean {
    return matchesExtension(path, this.extensions);
  }

  /** JSX-aware ScriptKind for the given path. */
  protected scriptKindFor(rt: TsModule, path: string): ts.ScriptKind {
    const lower = path.toLowerCase();
    if (lower.endsWith(".tsx")) return rt.ScriptKind.TSX;
    if (lower.endsWith(".jsx")) return rt.ScriptKind.JSX;
    if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
      return rt.ScriptKind.JS;
    }
    return rt.ScriptKind.TS;
  }

  async compress(input: CompressionInput): Promise<CompressionResult> {
    // Loading the parser and parsing the source are DIFFERENT causes of failure with
    // different remedies, so they get different warning codes (both keep the file FULL).
    let rt: TsModule;
    try {
      rt = await loadTs();
    } catch (error) {
      // The compressor itself could not be loaded (e.g. `typescript` is not installed).
      return fullResult(input, [
        {
          code: "compressor-unavailable",
          message: `Structure compressor unavailable (typescript could not be loaded): ${
            (error as Error)?.message ?? String(error)
          }`,
        },
      ]);
    }
    try {
      return this.compressSync(rt, input);
    } catch (error) {
      // The parser loaded but something went wrong parsing/shaping this source.
      return fullResult(input, [
        {
          code: "parse-failed",
          message: `Structure compression failed: ${(error as Error)?.message ?? String(error)}`,
        },
      ]);
    }
  }

  private compressSync(rt: TsModule, input: CompressionInput): CompressionResult {
    const { relpath, content } = input;

    const sourceFile = rt.createSourceFile(
      relpath,
      content,
      rt.ScriptTarget.Latest,
      /* setParentNodes */ false,
      this.scriptKindFor(rt, relpath),
    );

    // A file with actual syntax errors yields an unreliable AST: keep it FULL.
    // `parseDiagnostics` is populated by the parser but not on the public typings.
    const parseDiagnostics =
      (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      return fullResult(input, [
        {
          code: "parse-failed",
          message: "Source has syntax errors; kept full to avoid corrupting it.",
        },
      ]);
    }

    // Nothing to compress (empty file, or comments-only): keep FULL.
    if (sourceFile.statements.length === 0) {
      return fullResult(input, [
        { code: "too-small", message: "No top-level declarations to compress; kept full." },
      ]);
    }

    // 1) Collect the OUTERMOST omittable body spans (non-overlapping, source order).
    const spans = this.collectBodySpans(rt, sourceFile);

    // 2) Rebuild the source text with each body replaced by the placeholder.
    let body = "";
    let cursor = 0;
    for (const span of spans) {
      body += content.slice(cursor, span.start) + OMITTED_BODY;
      cursor = span.end;
    }
    body += content.slice(cursor);

    const output = compressionHeader(relpath) + body;

    // 3) Extract structural symbols (facts from the tree).
    const symbols = this.extractSymbols(rt, sourceFile, sourceFile.statements);

    const originalTokens = estimateTokens(content);
    const compressedTokens = estimateTokens(output);

    // The compressor reports the structural view; the registry decides whether the
    // reduction is worthwhile (it keeps the file FULL when tokens did not drop).
    return {
      representation: "compressed",
      originalTokens,
      compressedTokens,
      content: output,
      symbols,
      warnings: [],
    };
  }

  /** Depth-first collection of outermost function-like body block spans. */
  private collectBodySpans(
    rt: TsModule,
    sourceFile: ts.SourceFile,
  ): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];

    const visit = (node: ts.Node): void => {
      const body = bodyToOmit(rt, node);
      if (body) {
        // Replace the whole `{ ... }` block; do NOT descend (inner bodies vanish too).
        spans.push({ start: body.getStart(sourceFile), end: body.end });
        return;
      }
      rt.forEachChild(node, visit);
    };

    rt.forEachChild(sourceFile, visit);
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  // ---- symbol extraction -------------------------------------------------

  private extractSymbols(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  ): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    for (const statement of statements) {
      this.appendStatementSymbols(rt, sourceFile, statement, out);
    }
    return out;
  }

  private appendStatementSymbols(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    node: ts.Statement,
    out: ExtractedSymbol[],
  ): void {
    const exported = hasModifier(rt, node, rt.SyntaxKind.ExportKeyword);

    if (rt.isImportDeclaration(node)) {
      out.push(
        this.base(rt, sourceFile, node, "import", moduleSpecifierText(rt, node.moduleSpecifier)),
      );
      return;
    }
    if (rt.isImportEqualsDeclaration(node)) {
      out.push(this.base(rt, sourceFile, node, "import", node.name.text, exported));
      return;
    }
    if (rt.isExportDeclaration(node) || rt.isExportAssignment(node)) {
      out.push(
        this.base(rt, sourceFile, node, "export", this.exportName(rt, sourceFile, node), true),
      );
      return;
    }
    if (rt.isFunctionDeclaration(node)) {
      out.push(
        this.base(rt, sourceFile, node, "function", nameText(rt, node.name) ?? "default", exported),
      );
      return;
    }
    if (rt.isClassDeclaration(node)) {
      const symbol = this.base(
        rt,
        sourceFile,
        node,
        "class",
        nameText(rt, node.name) ?? "default",
        exported,
      );
      symbol.children = [
        ...this.decoratorSymbols(rt, sourceFile, node),
        ...this.classMemberSymbols(rt, sourceFile, node),
      ];
      out.push(symbol);
      return;
    }
    if (rt.isInterfaceDeclaration(node)) {
      out.push(this.base(rt, sourceFile, node, "interface", node.name.text, exported));
      return;
    }
    if (rt.isTypeAliasDeclaration(node)) {
      out.push(this.base(rt, sourceFile, node, "type", node.name.text, exported));
      return;
    }
    if (rt.isEnumDeclaration(node)) {
      out.push(this.base(rt, sourceFile, node, "enum", node.name.text, exported));
      return;
    }
    if (rt.isModuleDeclaration(node)) {
      const kind = rt.isStringLiteral(node.name) ? "module" : "namespace";
      const symbol = this.base(rt, sourceFile, node, kind, nameText(rt, node.name) ?? "", exported);
      if (node.body && rt.isModuleBlock(node.body)) {
        symbol.children = this.extractSymbols(rt, sourceFile, node.body.statements);
      }
      out.push(symbol);
      return;
    }
    if (rt.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        out.push(
          this.base(rt, sourceFile, decl, "constant", nameText(rt, decl.name) ?? "", exported),
        );
      }
      return;
    }
    // Other top-level statements (executable code, blocks, etc.) are not symbols.
  }

  private classMemberSymbols(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    node: ts.ClassDeclaration,
  ): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    for (const member of node.members) {
      const isPublic = !hasModifier(rt, member, rt.SyntaxKind.PrivateKeyword) &&
        !hasModifier(rt, member, rt.SyntaxKind.ProtectedKeyword);

      if (rt.isConstructorDeclaration(member)) {
        out.push(this.base(rt, sourceFile, member, "constructor", "constructor", isPublic));
      } else if (rt.isMethodDeclaration(member)) {
        const symbol = this.base(
          rt,
          sourceFile,
          member,
          "method",
          nameText(rt, member.name) ?? "",
          isPublic,
        );
        const decorators = this.decoratorSymbols(rt, sourceFile, member);
        if (decorators.length > 0) symbol.children = decorators;
        out.push(symbol);
      } else if (rt.isGetAccessorDeclaration(member) || rt.isSetAccessorDeclaration(member)) {
        out.push(
          this.base(rt, sourceFile, member, "method", nameText(rt, member.name) ?? "", isPublic),
        );
      } else if (rt.isPropertyDeclaration(member)) {
        out.push(
          this.base(rt, sourceFile, member, "field", nameText(rt, member.name) ?? "", isPublic),
        );
      }
    }
    return out;
  }

  private decoratorSymbols(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    node: ts.HasDecorators,
  ): ExtractedSymbol[] {
    const decorators = rt.getDecorators(node) ?? [];
    return decorators.map((decorator) => ({
      kind: "decorator" as const,
      name: normalizeWhitespace(decorator.expression.getText(sourceFile)),
      line: lineOf(sourceFile, decorator),
    }));
  }

  private exportName(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    node: ts.ExportDeclaration | ts.ExportAssignment,
  ): string {
    if (rt.isExportAssignment(node)) {
      return node.isExportEquals ? "export=" : "default";
    }
    if (node.moduleSpecifier) return moduleSpecifierText(rt, node.moduleSpecifier);
    if (node.exportClause) return normalizeWhitespace(node.exportClause.getText(sourceFile));
    return "*";
  }

  /** Build a symbol with a normalized (body-less) signature line. */
  private base(
    rt: TsModule,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: ExtractedSymbol["kind"],
    name: string,
    exported?: boolean,
  ): ExtractedSymbol {
    const symbol: ExtractedSymbol = {
      kind,
      name,
      signature: signatureOf(rt, sourceFile, node),
      line: lineOf(sourceFile, node),
    };
    if (exported !== undefined) symbol.exported = exported;
    return symbol;
  }
}

// ---- free helpers --------------------------------------------------------

/** The block body to omit for a function-like node, or undefined if there is none. */
function bodyToOmit(rt: TsModule, node: ts.Node): ts.Block | undefined {
  if (
    rt.isFunctionDeclaration(node) ||
    rt.isMethodDeclaration(node) ||
    rt.isConstructorDeclaration(node) ||
    rt.isGetAccessorDeclaration(node) ||
    rt.isSetAccessorDeclaration(node)
  ) {
    return node.body && rt.isBlock(node.body) ? node.body : undefined;
  }
  return undefined;
}

/** 1-based start line of a node. */
function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** The declaration text with the body stripped, whitespace collapsed to one line. */
function signatureOf(rt: TsModule, sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const body = bodyToOmit(rt, node);
  const end = body ? body.getStart(sourceFile) : node.end;
  return normalizeWhitespace(sourceFile.text.slice(start, end));
}

function hasModifier(rt: TsModule, node: ts.Node, kind: ts.ModifierSyntaxKind): boolean {
  if (!rt.canHaveModifiers(node)) return false;
  const modifiers = rt.getModifiers(node);
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function nameText(rt: TsModule, name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (rt.isIdentifier(name) || rt.isPrivateIdentifier(name)) return name.text;
  if (rt.isStringLiteralLike(name) || rt.isNumericLiteral(name)) return name.text;
  return undefined;
}

function moduleSpecifierText(rt: TsModule, specifier: ts.Expression | undefined): string {
  if (specifier && rt.isStringLiteralLike(specifier)) return specifier.text;
  return "";
}

// ---- public compressors --------------------------------------------------

/** Structure compressor for TypeScript sources (`.ts`, `.tsx`, `.mts`, `.cts`). */
export class TypeScriptCompressor extends TsLikeCompressor {
  readonly languageId = "typescript";
  protected readonly extensions = [".tsx", ".mts", ".cts", ".ts"] as const;

  override supports(path: string, content: string): boolean {
    // `.d.ts` / `.d.mts` / `.d.cts` are already declaration files — keep them full.
    if (/\.d\.(ts|mts|cts)$/i.test(path)) return false;
    return super.supports(path, content);
  }
}

/** Structure compressor for JavaScript sources (`.js`, `.jsx`, `.mjs`, `.cjs`). */
export class JavaScriptCompressor extends TsLikeCompressor {
  readonly languageId = "javascript";
  protected readonly extensions = [".jsx", ".mjs", ".cjs", ".js"] as const;
}
