import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  YUHI_VERSION,
  YuhiError,
  confineWithin,
  isVisibleToExternalAgent,
  sha256,
  workspacesDir,
  type FileDecision,
  type ManifestFile,
  type ScanResult,
  type WorkspaceManifest,
} from "@yuhi/shared";
import { redactText } from "@yuhi/scanner";

export interface CreateWorkspaceInput {
  sourceRoot: string;
  agent: string;
  policyHash: string;
  decisions: FileDecision[];
  scan: ScanResult;
  entropyThreshold: number;
  keywords: string[];
  isGitRepo: boolean;
  dryRun?: boolean;
  preserveGit?: boolean;
  /**
   * Transformer for the `prepare-locally` route (supplied by core's RouteExecutor).
   * Returns the transformed bytes, or null to block the file (e.g. a safety check
   * failed). If absent, prepare-locally files are blocked (fail safe).
   */
  prepareContent?: (relpath: string, bytes: Buffer) => Buffer | null;
}

export interface CreateWorkspaceResult {
  manifest: WorkspaceManifest;
  /** Directory the agent runs in (the filtered repo copy). */
  treeDir: string;
  baseDir: string;
  warnings: string[];
}

function safeChmod(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    /* Windows / restricted FS: best-effort only */
  }
}

/**
 * Generate a filtered workspace copy. NEVER modifies the source. Guards against
 * path traversal (confineWithin) and symlink escape (lstat + skip). Writes a
 * manifest with source+output hashes. Supports dry-run (compute, do not write).
 */
export function createWorkspace(input: CreateWorkspaceInput): CreateWorkspaceResult {
  const sourceRoot = path.resolve(input.sourceRoot);
  const warnings: string[] = [];
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseDir = path.join(workspacesDir(), id);
  const treeDir = path.join(baseDir, "repo");

  if (input.preserveGit) {
    warnings.push(
      "workspace.preserve_git is not implemented in v0.1; .git is NOT copied into the workspace.",
    );
  }

  if (!input.dryRun) {
    mkdirSync(treeDir, { recursive: true });
    safeChmod(baseDir, 0o700);
    safeChmod(treeDir, 0o700);
  }

  const flagsByPath = new Map(input.scan.files.map((f) => [f.relpath, f.flags]));

  const files: ManifestFile[] = [];
  const symlinksSkipped: string[] = [];
  const blocked: string[] = [];
  const localOnly: string[] = [];
  const treeHashParts: string[] = [];

  for (const decision of input.decisions) {
    const rel = decision.relpath;
    const flags = flagsByPath.get(rel);

    // Symlinks are never followed or copied (THREAT_MODEL T4).
    if (flags?.isSymlink) {
      symlinksSkipped.push(rel);
      continue;
    }

    const srcAbs = path.join(sourceRoot, rel);

    // TOCTOU guard: re-check the source is a regular file right before reading.
    let bytes: Buffer;
    try {
      const st = lstatSync(srcAbs);
      if (st.isSymbolicLink()) {
        symlinksSkipped.push(rel);
        continue;
      }
      if (!st.isFile()) {
        warnings.push(`Skipped non-regular file: ${rel}`);
        continue;
      }
      bytes = readFileSync(srcAbs);
    } catch {
      warnings.push(`Could not read source file: ${rel}`);
      continue;
    }

    const sourceSha256 = sha256(bytes);
    treeHashParts.push(`${rel}\0${sourceSha256}`);

    const visible = isVisibleToExternalAgent(decision.action);
    if (!visible) {
      if (decision.action === "local-only") localOnly.push(rel);
      else blocked.push(rel);
      files.push({
        relpath: rel,
        action: decision.action,
        ruleName: decision.ruleName,
        sourceSha256,
        outputSha256: null,
        transformed: false,
        bytes: bytes.length,
      });
      continue;
    }

    // Confine the destination strictly within the workspace tree.
    const destAbs = confineWithin(treeDir, rel);
    if (destAbs === null) {
      throw new YuhiError(
        "PATH_ESCAPE",
        `Refusing to write outside the workspace: ${rel}`,
        { hint: "This looks like a path traversal attempt and was blocked." },
      );
    }

    let outputBytes: Buffer = bytes;
    let transformed = false;

    if (decision.action === "redact") {
      if (flags?.isBinary) {
        // Cannot meaningfully redact binary; do not expose it.
        blocked.push(rel);
        files.push({
          relpath: rel,
          action: "block",
          ruleName: `${decision.ruleName} (binary→block)`,
          sourceSha256,
          outputSha256: null,
          transformed: false,
          bytes: bytes.length,
        });
        warnings.push(`Binary file marked for redaction was blocked instead: ${rel}`);
        continue;
      }
      const { redacted, count } = redactText(bytes.toString("utf8"), {
        entropyThreshold: input.entropyThreshold,
        keywords: input.keywords,
      });
      outputBytes = Buffer.from(redacted, "utf8");
      transformed = count > 0;
    }

    if (decision.action === "prepare-locally") {
      // Run the RouteExecutor pipeline; null = a safety check failed → block.
      const prepared = input.prepareContent ? input.prepareContent(rel, bytes) : null;
      if (prepared === null) {
        blocked.push(rel);
        files.push({
          relpath: rel,
          action: "block",
          ruleName: `${decision.ruleName} (blocked: prepare-locally)`,
          sourceSha256,
          outputSha256: null,
          transformed: false,
          bytes: bytes.length,
        });
        warnings.push(
          `"${rel}" did not pass its local safety check and was kept out of the context.`,
        );
        continue;
      }
      outputBytes = prepared;
      transformed = !prepared.equals(bytes);
    }

    if (!input.dryRun) {
      mkdirSync(path.dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, outputBytes, { mode: 0o600 });
    }

    files.push({
      relpath: rel,
      action: decision.action,
      ruleName: decision.ruleName,
      sourceSha256,
      outputSha256: sha256(outputBytes),
      transformed,
      bytes: outputBytes.length,
    });
  }

  const visibleCount = files.filter((f) => f.outputSha256 !== null).length;
  const transformedCount = files.filter((f) => f.transformed).length;

  const manifest: WorkspaceManifest = {
    id,
    createdAt: new Date().toISOString(),
    yuhiVersion: YUHI_VERSION,
    policyHash: input.policyHash,
    agent: input.agent,
    source: {
      path: sourceRoot,
      treeHash: sha256(treeHashParts.sort().join("\n")),
      isGitRepo: input.isGitRepo,
    },
    workspacePath: treeDir,
    files,
    symlinksSkipped,
    blocked,
    localOnly,
    counts: {
      visible: visibleCount,
      transformed: transformedCount,
      blocked: blocked.length,
      localOnly: localOnly.length,
      symlinksSkipped: symlinksSkipped.length,
    },
  };

  if (!input.dryRun) {
    writeFileSync(path.join(baseDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
  }

  return { manifest, treeDir, baseDir, warnings };
}
