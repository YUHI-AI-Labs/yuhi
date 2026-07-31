/**
 * v0.3 Repository Overview — a lightweight, deterministic map of the repository so
 * both the user and the agent get oriented fast. NOT semantic retrieval (that is
 * v0.4). Pure and fast: derived from the delivered file paths only.
 *
 *   Repository Overview
 *   Applications        128
 *   Libraries            64
 *   Tests                90
 *   Documentation        12
 *   Configuration         8
 *
 *   Top modules
 *   authentication · billing · api · database
 */

export interface RepositoryOverview {
  categories: { name: string; count: number }[];
  topModules: string[];
  totalFiles: number;
}

const CATEGORY_ORDER = [
  "Applications",
  "Libraries",
  "Tests",
  "Documentation",
  "Configuration",
  "Data",
  "Other",
] as const;

function categorize(relpath: string): (typeof CATEGORY_ORDER)[number] {
  const p = relpath.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/(^|\/)(tests?|__tests__|spec|e2e)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(base)) return "Tests";
  if (/(^|\/)(docs?|documentation|wiki)\//.test(p) || /\.(md|mdx|rst|adoc)$/.test(base)) return "Documentation";
  if (/(^|\/)(apps?|src|cmd|services?|server|web|frontend|backend)\//.test(p)) return "Applications";
  if (/(^|\/)(packages?|libs?|lib|modules?|internal|pkg)\//.test(p)) return "Libraries";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|env|lock)$/.test(base) || /(^|\/)\.[a-z]/.test(p)) return "Configuration";
  if (/\.(csv|tsv|parquet|xlsx|xls|db|sqlite|ndjson|jsonl)$/.test(base)) return "Data";
  return "Other";
}

/** Module name from the first two path segments, cleaned for display. */
function moduleKey(relpath: string): string | undefined {
  const segs = relpath.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  // Skip common top wrappers to reach the meaningful module directory.
  const skip = new Set(["src", "apps", "packages", "lib", "libs", "internal", "pkg", "app", "services"]);
  const idx = skip.has(segs[0]!.toLowerCase()) && segs.length > 2 ? 1 : 0;
  const raw = segs[idx]!.toLowerCase();
  if (skip.has(raw) || raw.startsWith(".") || raw.length < 2) return undefined;
  return raw.replace(/[_-]+/g, " ");
}

/**
 * Build a deterministic overview from the delivered relative paths. Stable ordering,
 * no randomness, no I/O.
 */
export function buildRepositoryOverview(
  relpaths: readonly string[],
  maxModules = 8,
): RepositoryOverview {
  const catCounts = new Map<string, number>();
  const modCounts = new Map<string, number>();
  for (const rel of relpaths) {
    const cat = categorize(rel);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    const mod = moduleKey(rel);
    if (mod) modCounts.set(mod, (modCounts.get(mod) ?? 0) + 1);
  }
  const categories = CATEGORY_ORDER
    .map((name) => ({ name, count: catCounts.get(name) ?? 0 }))
    .filter((c) => c.count > 0);
  const topModules = [...modCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) // count desc, then name asc (stable)
    .slice(0, maxModules)
    .map(([name]) => name);
  return { categories, topModules, totalFiles: relpaths.length };
}

export function formatRepositoryOverview(o: RepositoryOverview): string {
  const lines = ["Repository Overview", ""];
  const width = Math.max(0, ...o.categories.map((c) => c.name.length));
  for (const c of o.categories) lines.push(`  ${c.name.padEnd(width)}  ${String(c.count).padStart(5)}`);
  if (o.topModules.length) {
    lines.push("", "  Top modules", `  ${o.topModules.join(" · ")}`);
  }
  return lines.join("\n");
}
