import path from "node:path";
import { parseDelimitedTable } from "@yuhi/shared";
import { estimateTokens, fullResult } from "./registry.js";
import type { CompressionInput, CompressionResult, SourceCompressor } from "./types.js";

/** Deterministic, value-minimizing representations for common oversized artifacts. */
export class LargeArtifactCompressor implements SourceCompressor {
  readonly languageId = "large-artifact";

  supports(relpath: string): boolean {
    return /\.(?:html?|json|csv|tsv|log)$/i.test(relpath);
  }

  async compress(input: CompressionInput): Promise<CompressionResult> {
    const ext = path.extname(input.relpath).toLowerCase();
    const originalTokens = estimateTokens(input.content);
    if (originalTokens < 2_000) return fullResult(input, [{ code: "too-small", message: "Artifact is already small; kept full." }]);
    let body: string;
    if (ext === ".json") body = jsonOutline(input.content);
    else if (ext === ".csv" || ext === ".tsv") body = tableOutline(input.content);
    else if (ext === ".log") body = logOutline(input.content);
    else body = htmlOutline(input.content);
    const content = `# Yuhi compact representation\n\nSource: ${input.relpath}\n\n${body}\n`;
    return {
      representation: "compressed",
      originalTokens,
      compressedTokens: estimateTokens(content),
      content,
      symbols: [],
      warnings: [],
    };
  }
}

function jsonOutline(content: string): string {
  const value = JSON.parse(content) as unknown;
  const lines = ["## JSON structure", ""];
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(node)) {
      lines.push(`${prefix || "root"}: array (${node.length} items)`);
      if (node.length > 0) walk(node[0], `${prefix}[]`, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const keys = Object.keys(node as Record<string, unknown>).sort();
      lines.push(`${prefix || "root"}: object (${keys.length} keys)`);
      for (const key of keys.slice(0, 200)) walk((node as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, depth + 1);
      return;
    }
    lines.push(`${prefix}: ${node === null ? "null" : typeof node}`);
  };
  walk(value, "", 0);
  return lines.join("\n");
}

function tableOutline(content: string): string {
  const table = parseDelimitedTable(content);
  const headers = table.rows[0] ?? [];
  return [
    "## Table structure",
    "",
    `- Rows: ${Math.max(0, table.rows.length - 1)}`,
    `- Columns: ${headers.length}`,
    "- Headers:",
    ...headers.map((header, index) => `  - ${index + 1}: ${header || `(column ${index + 1})`}`),
    "",
    "Cell values are omitted from this compact representation. The full original remains available.",
  ].join("\n");
}

function logOutline(content: string): string {
  const lines = content.split(/\r?\n/);
  const count = (pattern: RegExp): number => lines.filter((line) => pattern.test(line)).length;
  return [
    "## Log structure",
    "",
    `- Lines: ${lines.length}`,
    `- Error-like lines: ${count(/\b(?:error|fatal|panic)\b/i)}`,
    `- Warning-like lines: ${count(/\bwarn(?:ing)?\b/i)}`,
    `- Info-like lines: ${count(/\binfo\b/i)}`,
    "",
    "Log messages and values are omitted from this compact representation.",
  ].join("\n");
}

function htmlOutline(content: string): string {
  const count = (tag: string): number => (content.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
  const title = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return [
    "## HTML structure",
    "",
    ...(title ? [`- Title: ${title}`] : []),
    `- Headings: ${count("h[1-6]")}`,
    `- Links: ${count("a")}`,
    `- Forms: ${count("form")}`,
    `- Tables: ${count("table")}`,
    `- Scripts: ${count("script")}`,
    `- Styles: ${count("style")}`,
    "",
    "Page body text and attribute values are omitted. The full original remains available.",
  ].join("\n");
}
