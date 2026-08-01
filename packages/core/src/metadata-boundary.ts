/**
 * The agent-visible METADATA boundary (v0.3.6).
 *
 * Keeping a sensitive file's bytes out of the Prepared Workspace is only half the
 * job: in a real workspace the FILENAME is itself identifying data — submissions
 * arrive as `9999990001 評定-0722.xlsx`, rosters as `3年B組-名簿.pdf`. If such a
 * name survives in a file the agent can read, the original was withheld and the
 * identifier was disclosed anyway.
 *
 * Yuhi therefore keeps two layers:
 *
 *   PRIVATE — the source relpath, the `originalRelpath` pseudonym mapping,
 *     absolute paths, the run/source binding, and the background queue records.
 *     Stored only OUTSIDE every agent-visible root (under the managed base) or
 *     in memory for the local UI, which shows the user their own filenames.
 *
 *   PUBLIC — everything at or below the prepared root: the delivered tree plus
 *     `manifest.json`, `.yuhi/background-status.json`, `.yuhi/session.json`,
 *     `.yuhi/yuhi-mode-summary.json`, `.yuhi/context/AGENT_HANDOFF.md` and
 *     `.yuhi/context/document-index.md`. A file whose ORIGINAL was not delivered
 *     may appear here ONLY as a {@link documentIdFor} identity plus the kind-only
 *     {@link withheldDisplayName} — never as a path, and never as an
 *     `originalRelpath`.
 *
 * Identity still crosses the boundary, so counts, dedup, and revisions stay exact:
 * `documentId` is a stable salted digest of the private source path, so the same
 * file lines up across every public surface without any surface carrying its name.
 *
 * {@link buildWithheldRedactions} + {@link redactMetadata} are the defense-in-depth
 * half. Structural projection is the primary control; the redaction pass then
 * rewrites any withheld name that reached a free-text field (a policy `reason`, a
 * rendered index line) that no per-field projection would have caught.
 */
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Stable, non-reversible public identity for one source document. Derived from the
 * policy salt, so it is deterministic for a workspace (a re-prepare produces the
 * same id) while not being reversible to the filename.
 */
export function documentIdFor(sourceRelpath: string, salt: string): string {
  const digest = createHash("sha256").update(`${salt}:document:${sourceRelpath}`).digest("hex");
  return `doc-${digest.slice(0, 12)}`;
}

/** The extension is a KIND, not an identity — anything unusual is dropped, not echoed. */
function safeExtension(sourceRelpath: string): string {
  const ext = path.posix.extname(sourceRelpath).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/**
 * The ONLY name an agent-visible surface may use for a withheld file: `doc-<id>.pdf`.
 * It carries the document kind — so "1 PDF kept local" stays explainable — and
 * nothing else. No directory, no stem, no identifier.
 */
export function withheldDisplayName(sourceRelpath: string, documentId: string): string {
  return `${documentId}${safeExtension(sourceRelpath)}`;
}

/** One file whose original never reached the agent-visible tree. */
export interface WithheldDocument {
  /** PRIVATE source relpath. Never written to a public surface. */
  sourceRelpath: string;
  documentId: string;
}

/** A single name → public-label rewrite applied to agent-visible text. */
export interface MetadataRedaction {
  token: string;
  replacement: string;
}

/**
 * Tokens shorter than this are skipped: they are too generic to be identifying and
 * too likely to appear inside unrelated prose.
 */
const MIN_TOKEN_LENGTH = 3;

/** Every path-ish token that could carry the name of `relpath`. */
function nameTokens(relpath: string): string[] {
  const segments = relpath.split("/").filter((segment) => segment !== "");
  const basename = segments.at(-1) ?? "";
  const ext = path.posix.extname(basename);
  const stem = ext ? basename.slice(0, -ext.length) : basename;
  return [relpath, basename, stem, ...segments.slice(0, -1)];
}

/**
 * Build the rewrite list for one run: every token that names a WITHHELD file, mapped
 * to that file's public display name.
 *
 * A token that appears ANYWHERE in a DELIVERED path is dropped — the agent can already
 * see that name in its own tree, and rewriting it would corrupt a legitimate path
 * (a withheld `config/.env` must not turn a delivered `config/.env.example` into
 * `doc-….example`). Substring, not equality: the collision that matters is textual,
 * because the rewrite itself is textual.
 */
export function buildWithheldRedactions(input: {
  withheld: readonly WithheldDocument[];
  delivered: readonly string[];
}): MetadataRedaction[] {
  // Newline-joined so no token can straddle two delivered paths.
  const deliveredPaths = input.delivered.join("\n");
  const byToken = new Map<string, string>();
  for (const document of input.withheld) {
    const replacement = withheldDisplayName(document.sourceRelpath, document.documentId);
    for (const token of nameTokens(document.sourceRelpath)) {
      if (token.length < MIN_TOKEN_LENGTH || deliveredPaths.includes(token)) continue;
      // First writer wins, so two withheld files sharing a directory produce a
      // deterministic rewrite for that shared segment.
      if (!byToken.has(token)) byToken.set(token, replacement);
    }
  }
  return [...byToken]
    .map(([token, replacement]) => ({ token, replacement }))
    // Longest first: a full relpath must be rewritten before its own basename.
    .sort((a, b) => b.token.length - a.token.length || (a.token < b.token ? -1 : 1));
}

function rewrite(value: string, redactions: readonly MetadataRedaction[]): string {
  let result = value;
  for (const { token, replacement } of redactions) {
    if (result.includes(token)) result = result.split(token).join(replacement);
  }
  return result;
}

/**
 * Deep-copy `value`, rewriting every withheld name found in any string it contains.
 * Object KEYS are field names, not data, and are left alone. Strings are accepted
 * directly so a rendered Markdown surface can be passed through unchanged.
 */
export function redactMetadata<T>(value: T, redactions: readonly MetadataRedaction[]): T {
  if (redactions.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rewrite(node, redactions);
    if (Array.isArray(node)) return node.map((child) => walk(child));
    if (node !== null && typeof node === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) result[key] = walk(child);
      return result;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * The adversarial metadata scan: which of `tokens` survived into `value`. Used by the
 * regression suite to assert `raw identifier = 0` across every agent-visible surface,
 * and usable on a raw file's text as well as on a parsed object.
 */
export function findMetadataLeaks(value: unknown, tokens: readonly string[]): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const token of tokens) if (token !== "" && node.includes(token)) found.add(token);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const child of Object.values(node)) walk(child);
    }
  };
  walk(value);
  return [...found].sort();
}
