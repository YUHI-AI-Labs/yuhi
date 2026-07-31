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
 */
import ts from "typescript";
import { estimateTokens, fullResult } from "./registry.js";
import { compressionHeader } from "./types.js";
import type {
  CompressionInput,
  CompressionResult,
  ExtractedSymbol,
  SourceCompressor,
} from "./types.js";

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
  protected scriptKindFor(path: string): ts.ScriptKind {
    const lower = path.toLowerCase();
    if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
      return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
  }

  async compress(input: CompressionInput): Promise<CompressionResult> {
    try {
      return this.compressSync(input);
    } catch (error) {
      // Contract: never throw. Keep the file FULL with a warning.
      return fullResult(input, [
        {
          code: "parse-failed",
          message: `Structure compression failed: ${(error as Error)?.message ?? String(error)}`,
        },
      ]);
    }
  }

  private compressSync(input: CompressionInput): CompressionResult {
    const { relpath, content } = input;

    const sourceFile = ts.createSourceFile(
      relpath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      this.scriptKindFor(relpath),
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
    const spans = this.collectBodySpans(sourceFile);

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
    const symbols = this.extractSymbols(sourceFile, sourceFile.statements);

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
  private collectBodySpans(sourceFile: ts.SourceFile): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];

    const visit = (node: ts.Node): void => {
      const body = bodyToOmit(node);
      if (body) {
        // Replace the whole `{ ... }` block; do NOT descend (inner bodies vanish too).
        spans.push({ start: body.getStart(sourceFile), end: body.end });
        return;
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  // ---- symbol extraction -------------------------------------------------

  private extractSymbols(
    sourceFile: ts.SourceFile,
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  ): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    for (const statement of statements) {
      this.appendStatementSymbols(sourceFile, statement, out);
    }
    return out;
  }

  private appendStatementSymbols(
    sourceFile: ts.SourceFile,
    node: ts.Statement,
    out: ExtractedSymbol[],
  ): void {
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);

    if (ts.isImportDeclaration(node)) {
      out.push(this.base(sourceFile, node, "import", moduleSpecifierText(node.moduleSpecifier)));
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      out.push(this.base(sourceFile, node, "import", node.name.text, exported));
      return;
    }
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      out.push(this.base(sourceFile, node, "export", this.exportName(sourceFile, node), true));
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      out.push(this.base(sourceFile, node, "function", nameText(node.name) ?? "default", exported));
      return;
    }
    if (ts.isClassDeclaration(node)) {
      const symbol = this.base(
        sourceFile,
        node,
        "class",
        nameText(node.name) ?? "default",
        exported,
      );
      symbol.children = [
        ...this.decoratorSymbols(sourceFile, node),
        ...this.classMemberSymbols(sourceFile, node),
      ];
      out.push(symbol);
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      out.push(this.base(sourceFile, node, "interface", node.name.text, exported));
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      out.push(this.base(sourceFile, node, "type", node.name.text, exported));
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      out.push(this.base(sourceFile, node, "enum", node.name.text, exported));
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      const kind = ts.isStringLiteral(node.name) ? "module" : "namespace";
      const symbol = this.base(sourceFile, node, kind, nameText(node.name) ?? "", exported);
      if (node.body && ts.isModuleBlock(node.body)) {
        symbol.children = this.extractSymbols(sourceFile, node.body.statements);
      }
      out.push(symbol);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        out.push(this.base(sourceFile, decl, "constant", nameText(decl.name) ?? "", exported));
      }
      return;
    }
    // Other top-level statements (executable code, blocks, etc.) are not symbols.
  }

  private classMemberSymbols(
    sourceFile: ts.SourceFile,
    node: ts.ClassDeclaration,
  ): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    for (const member of node.members) {
      const isPublic = !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
        !hasModifier(member, ts.SyntaxKind.ProtectedKeyword);

      if (ts.isConstructorDeclaration(member)) {
        out.push(this.base(sourceFile, member, "constructor", "constructor", isPublic));
      } else if (ts.isMethodDeclaration(member)) {
        const symbol = this.base(
          sourceFile,
          member,
          "method",
          nameText(member.name) ?? "",
          isPublic,
        );
        const decorators = this.decoratorSymbols(sourceFile, member);
        if (decorators.length > 0) symbol.children = decorators;
        out.push(symbol);
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        out.push(this.base(sourceFile, member, "method", nameText(member.name) ?? "", isPublic));
      } else if (ts.isPropertyDeclaration(member)) {
        out.push(this.base(sourceFile, member, "field", nameText(member.name) ?? "", isPublic));
      }
    }
    return out;
  }

  private decoratorSymbols(sourceFile: ts.SourceFile, node: ts.HasDecorators): ExtractedSymbol[] {
    const decorators = ts.getDecorators(node) ?? [];
    return decorators.map((decorator) => ({
      kind: "decorator" as const,
      name: normalizeWhitespace(decorator.expression.getText(sourceFile)),
      line: lineOf(sourceFile, decorator),
    }));
  }

  private exportName(sourceFile: ts.SourceFile, node: ts.ExportDeclaration | ts.ExportAssignment): string {
    if (ts.isExportAssignment(node)) {
      return node.isExportEquals ? "export=" : "default";
    }
    if (node.moduleSpecifier) return moduleSpecifierText(node.moduleSpecifier);
    if (node.exportClause) return normalizeWhitespace(node.exportClause.getText(sourceFile));
    return "*";
  }

  /** Build a symbol with a normalized (body-less) signature line. */
  private base(
    sourceFile: ts.SourceFile,
    node: ts.Node,
    kind: ExtractedSymbol["kind"],
    name: string,
    exported?: boolean,
  ): ExtractedSymbol {
    const symbol: ExtractedSymbol = {
      kind,
      name,
      signature: signatureOf(sourceFile, node),
      line: lineOf(sourceFile, node),
    };
    if (exported !== undefined) symbol.exported = exported;
    return symbol;
  }
}

// ---- free helpers --------------------------------------------------------

/** The block body to omit for a function-like node, or undefined if there is none. */
function bodyToOmit(node: ts.Node): ts.Block | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body && ts.isBlock(node.body) ? node.body : undefined;
  }
  return undefined;
}

/** 1-based start line of a node. */
function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** The declaration text with the body stripped, whitespace collapsed to one line. */
function signatureOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const body = bodyToOmit(node);
  const end = body ? body.getStart(sourceFile) : node.end;
  return normalizeWhitespace(sourceFile.text.slice(start, end));
}

function hasModifier(node: ts.Node, kind: ts.ModifierSyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function moduleSpecifierText(specifier: ts.Expression | undefined): string {
  if (specifier && ts.isStringLiteralLike(specifier)) return specifier.text;
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
