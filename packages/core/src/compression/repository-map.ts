/**
 * v0.3.3 Repository Map — a short, deterministic, human-readable map of a repository.
 *
 * This is NOT a call graph. It renders directory nesting, each file, and its MAJOR
 * structural symbols (preferring exported/public ones), plus a compact list of
 * entry points and intra-repo import relationships. Everything is derived from facts
 * already extracted elsewhere (paths, ExtractedSymbols, raw import specifiers) — the
 * map never infers or summarizes, and it never calls an LLM.
 *
 * Determinism is a hard requirement: same input → byte-identical `text`. Every list is
 * sorted with a locale-independent comparator, symbols render in source order, and
 * budget-trimming drops whole files by a stable importance ranking.
 */
import type { ExtractedSymbol } from "./types.js";
import { estimateTokens } from "./registry.js";

/** One file as seen by the map builder. */
export interface RepositoryMapFile {
  /** Repo-relative path. Windows separators are normalized to POSIX on input. */
  relpath: string;
  /** Structural symbols extracted from the file (may be empty/omitted). */
  symbols?: ExtractedSymbol[];
  /** True when this file is a repository entry point. */
  isEntryPoint?: boolean;
  /** Raw module specifiers this file imports (e.g. "./scanner.js", "react"). */
  imports?: string[];
}

/** A resolved intra-repo import relationship. */
export interface RepositoryMapImportEdge {
  from: string;
  to: string;
}

export interface RepositoryMap {
  /** The rendered tree (deterministic; ends with a trailing newline). */
  text: string;
  /** estimateTokens(text). */
  tokens: number;
  /** All entry-point relpaths, sorted. */
  entryPoints: string[];
  /** Resolved intra-repo edges only, best-effort. External/unresolved dropped. */
  importEdges: RepositoryMapImportEdge[];
  /** True when the map was trimmed to fit the token budget. */
  truncated: boolean;
  /** Number of files dropped from the map due to the budget. */
  omittedFiles: number;
}

export interface RepositoryMapOptions {
  /** repositoryMapTokenBudget — the map is trimmed to fit this many tokens. */
  tokenBudget?: number;
}

const DEFAULT_TOKEN_BUDGET = 5000;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_CHILD_SYMBOLS = 10;

/** Symbol kinds that are structural noise in a map (shown elsewhere or not at all). */
const HIDDEN_SYMBOL_KINDS = new Set<ExtractedSymbol["kind"]>(["import", "export", "decorator"]);

/** Extensions tried, in order, when resolving an extensionless relative import. */
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".d.ts",
];

/** Locale-independent string compare (code-unit order) — deterministic across machines. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize a raw relpath to a repo-relative POSIX path. Returns "" for empty/invalid. */
function normalizeRelpath(raw: string): string {
  if (typeof raw !== "string") return "";
  // Windows separators → POSIX, then collapse "." / ".." and drop empty segments.
  const posix = raw.replace(/\\/g, "/");
  return normalizePosixSegments(posix);
}

/** Collapse a POSIX path: drop "" and ".", resolve ".." where possible. */
function normalizePosixSegments(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (out.length > 0 && top !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function posixDirname(relpath: string): string {
  const i = relpath.lastIndexOf("/");
  return i === -1 ? "" : relpath.slice(0, i);
}

function posixBasename(relpath: string): string {
  const i = relpath.lastIndexOf("/");
  return i === -1 ? relpath : relpath.slice(i + 1);
}

/** A normalized, deduplicated file record with a precomputed importance score. */
interface FileRecord {
  relpath: string;
  depth: number;
  isEntryPoint: boolean;
  symbols: ExtractedSymbol[];
  importsRaw: string[];
  hasExported: boolean;
  importance: number;
}

function displayableSymbols(symbols: readonly ExtractedSymbol[]): ExtractedSymbol[] {
  return symbols.filter(
    (s) => s && typeof s.name === "string" && s.name.length > 0 && !HIDDEN_SYMBOL_KINDS.has(s.kind),
  );
}

function hasExportedSymbol(symbols: readonly ExtractedSymbol[]): boolean {
  for (const s of symbols) {
    if (!s) continue;
    if (s.exported) return true;
    if (s.children && s.children.length > 0 && hasExportedSymbol(s.children)) return true;
  }
  return false;
}

/** Order symbols by source line (undefined last), then name — deterministic. */
function orderSymbols(list: readonly ExtractedSymbol[]): ExtractedSymbol[] {
  return [...list].sort((a, b) => {
    const la = a.line ?? Number.MAX_SAFE_INTEGER;
    const lb = b.line ?? Number.MAX_SAFE_INTEGER;
    return la - lb || cmpStr(a.name, b.name);
  });
}

/**
 * Pick up to `max` symbols, preferring exported/public ones, and return them in
 * source order for display. Exported-first selection is stable and deterministic.
 */
function capSelect(list: readonly ExtractedSymbol[], max: number): ExtractedSymbol[] {
  const ordered = orderSymbols(list);
  if (ordered.length <= max) return ordered;
  const exported = ordered.filter((s) => s.exported);
  const rest = ordered.filter((s) => !s.exported);
  const chosen = [...exported, ...rest].slice(0, max);
  return orderSymbols(chosen);
}

/** Render a single symbol to its map line (signature if present, else a kind-based label). */
function formatSymbol(sym: ExtractedSymbol): string {
  const sig = sym.signature?.trim();
  if (sig) return sig;
  const name = sym.name;
  switch (sym.kind) {
    case "class":
      return `class ${name}`;
    case "interface":
      return `interface ${name}`;
    case "enum":
      return `enum ${name}`;
    case "type":
      return `type ${name}`;
    case "namespace":
    case "module":
      return `namespace ${name}`;
    case "function":
      return `function ${name}()`;
    case "method":
      return `${name}()`;
    case "constructor":
      return `constructor()`;
    case "constant":
      return `const ${name}`;
    default:
      return name;
  }
}

/** Append symbol lines (indented relative to the file line) into `out`. */
function collectSymbolLines(
  symbols: readonly ExtractedSymbol[],
  relIndent: number,
  isTopLevel: boolean,
  out: string[],
): void {
  const displayable = displayableSymbols(symbols);
  if (displayable.length === 0) return;
  const cap = isTopLevel ? MAX_SYMBOLS_PER_FILE : MAX_CHILD_SYMBOLS;
  const chosen = capSelect(displayable, cap);
  const pad = "  ".repeat(relIndent);
  for (const sym of chosen) {
    out.push(pad + formatSymbol(sym));
    if (sym.children && sym.children.length > 0) {
      collectSymbolLines(sym.children, relIndent + 1, false, out);
    }
  }
}

// --- Directory tree -------------------------------------------------------------

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: FileRecord[];
}

function newTreeDir(): TreeDir {
  return { dirs: new Map(), files: [] };
}

function insertIntoTree(root: TreeDir, record: FileRecord): void {
  const segments = record.relpath.split("/");
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i]!;
    let child = node.dirs.get(dir);
    if (!child) {
      child = newTreeDir();
      node.dirs.set(dir, child);
    }
    node = child;
  }
  node.files.push(record);
}

function renderTree(node: TreeDir, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  const dirNames = [...node.dirs.keys()].sort(cmpStr);
  for (const name of dirNames) {
    out.push(`${pad}${name}/`);
    renderTree(node.dirs.get(name)!, depth + 1, out);
  }
  const files = [...node.files].sort((a, b) => cmpStr(a.relpath, b.relpath));
  for (const file of files) {
    const marker = file.isEntryPoint ? " (entry point)" : "";
    out.push(`${pad}${posixBasename(file.relpath)}${marker}`);
    collectSymbolLines(file.symbols, depth + 1, true, out);
  }
}

// --- Import resolution ----------------------------------------------------------

/** Resolve a relative import specifier against the file set. Returns a relpath or undefined. */
function resolveRelativeImport(
  fromRelpath: string,
  spec: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  const normalizedSpec = spec.replace(/\\/g, "/"); // tolerate Windows-style specifiers
  if (!normalizedSpec.startsWith(".")) return undefined; // external module → dropped
  const baseDir = posixDirname(fromRelpath);
  const joined = normalizePosixSegments(`${baseDir}/${normalizedSpec}`);
  if (joined === "" || joined.startsWith("..")) return undefined; // escaped the repo root

  const candidates: string[] = [];
  const push = (c: string): void => {
    if (!candidates.includes(c)) candidates.push(c);
  };
  // Exact specifier (e.g. an explicit "./foo.ts" or "./data.json").
  push(joined);
  // TS ESM convention: "./foo.js" often refers to the "./foo.ts" source.
  push(joined.replace(/\.js$/, ".ts"));
  push(joined.replace(/\.jsx$/, ".tsx"));
  push(joined.replace(/\.mjs$/, ".mts"));
  push(joined.replace(/\.cjs$/, ".cts"));
  // Extensionless import → try known source extensions.
  for (const ext of RESOLVE_EXTENSIONS) push(joined + ext);
  // Directory import → try its index file.
  for (const ext of RESOLVE_EXTENSIONS) push(`${joined}/index${ext}`);

  for (const candidate of candidates) {
    if (candidate !== fromRelpath && fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveImportEdges(records: readonly FileRecord[]): RepositoryMapImportEdge[] {
  const fileSet = new Set(records.map((r) => r.relpath));
  const seen = new Set<string>();
  const edges: RepositoryMapImportEdge[] = [];
  for (const record of records) {
    for (const spec of record.importsRaw) {
      if (typeof spec !== "string" || spec.length === 0) continue;
      const to = resolveRelativeImport(record.relpath, spec, fileSet);
      if (!to) continue;
      const key = `${record.relpath} ${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: record.relpath, to });
    }
  }
  edges.sort((a, b) => cmpStr(a.from, b.from) || cmpStr(a.to, b.to));
  return edges;
}

// --- Rendering ------------------------------------------------------------------

function renderMapText(
  kept: readonly FileRecord[],
  entryPoints: readonly string[],
  edges: readonly RepositoryMapImportEdge[],
): string {
  const keptSet = new Set(kept.map((r) => r.relpath));
  const lines: string[] = ["# Repository Map", ""];

  const root = newTreeDir();
  for (const record of [...kept].sort((a, b) => cmpStr(a.relpath, b.relpath))) {
    insertIntoTree(root, record);
  }
  const treeLines: string[] = [];
  renderTree(root, 0, treeLines);
  if (treeLines.length === 0) {
    lines.push("(no files)");
  } else {
    lines.push(...treeLines);
  }

  const keptEntryPoints = entryPoints.filter((e) => keptSet.has(e));
  if (keptEntryPoints.length > 0) {
    lines.push("", "## Entry points");
    for (const e of keptEntryPoints) lines.push(`  ${e}`);
  }

  const keptEdges = edges.filter((e) => keptSet.has(e.from) && keptSet.has(e.to));
  if (keptEdges.length > 0) {
    lines.push("", "## Imports");
    for (const e of keptEdges) lines.push(`  ${e.from} -> ${e.to}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Build a deterministic Repository Map from a set of files.
 *
 * Import edges are best-effort: only RELATIVE specifiers are resolved, against the
 * repo file set, trying the exact path, the TS-ESM `.js`→`.ts` swap, known source
 * extensions, and directory `index.*` files; anything unresolved or external is dropped.
 *
 * Budget trimming drops whole files (never partial lines) by an importance ranking —
 * entry points first, then files with exported symbols, then shallower files — keeping
 * the most important files that fit `tokenBudget`. Trimming is always recorded via
 * `truncated` and `omittedFiles`.
 */
export function buildRepositoryMap(
  files: readonly RepositoryMapFile[],
  opts?: RepositoryMapOptions,
): RepositoryMap {
  const budget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  // 1. Normalize, skip empty/invalid relpaths, dedupe (first normalized wins).
  const byPath = new Map<string, FileRecord>();
  for (const file of files ?? []) {
    if (!file) continue;
    const relpath = normalizeRelpath(file.relpath);
    if (relpath === "") continue; // empty or symlink-like → skipped safely
    if (byPath.has(relpath)) continue;
    const symbols = Array.isArray(file.symbols) ? file.symbols.filter(Boolean) : [];
    const importsRaw = Array.isArray(file.imports) ? file.imports : [];
    byPath.set(relpath, {
      relpath,
      depth: relpath.split("/").length - 1,
      isEntryPoint: Boolean(file.isEntryPoint),
      symbols,
      importsRaw,
      hasExported: hasExportedSymbol(symbols),
      importance: 0,
    });
  }

  const records = [...byPath.values()];
  for (const r of records) {
    // Higher = kept longer under budget pressure.
    r.importance =
      (r.isEntryPoint ? 1_000_000_000 : 0) +
      (r.hasExported ? 1_000_000 : 0) +
      (100 - Math.min(r.depth, 100)) * 1000 +
      Math.min(displayableSymbols(r.symbols).length, 500);
  }

  const entryPoints = records
    .filter((r) => r.isEntryPoint)
    .map((r) => r.relpath)
    .sort(cmpStr);
  const importEdges = resolveImportEdges(records);

  // 2. Rank by importance (desc), path (asc) for a deterministic keep order.
  const ranked = [...records].sort(
    (a, b) => b.importance - a.importance || cmpStr(a.relpath, b.relpath),
  );

  const render = (n: number): string =>
    renderMapText(ranked.slice(0, n), entryPoints, importEdges);

  const full = render(ranked.length);
  const fullTokens = estimateTokens(full);

  if (fullTokens <= budget || ranked.length === 0) {
    return {
      text: full,
      tokens: fullTokens,
      entryPoints,
      importEdges,
      truncated: false,
      omittedFiles: 0,
    };
  }

  // 3. Over budget: binary-search the largest prefix of the ranking that fits.
  // Text length is monotonic in the prefix size, so the fit predicate is monotonic.
  let lo = 0;
  let hi = ranked.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateTokens(render(mid)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const keptText = render(best);
  return {
    text: keptText,
    tokens: estimateTokens(keptText),
    entryPoints,
    importEdges,
    truncated: true,
    omittedFiles: ranked.length - best,
  };
}
