/**
 * Archive detection for the preparation boundary.
 *
 * An archive is opaque to every content scanner Yuhi has: the bytes the agent
 * would receive cannot be inspected, de-identified, or verified, so "include the
 * original with an inspection-pending warning" is the wrong contract for it. An
 * ENCRYPTED archive is worse — it cannot be inspected even in the background, so
 * it can never graduate to a verified companion.
 *
 * Nothing here ever reads or reports an archive's ENTRY NAMES: an entry name is
 * itself untrusted, potentially identifying content, and must not reach any
 * agent-visible or public surface.
 */

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar", "jar", "war", "iso", "dmg",
]);

/** Extension-based archive detection over a repo-relative POSIX path. */
export function isArchivePath(relpath: string): boolean {
  const base = relpath.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return ARCHIVE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export type ArchiveEncryption = "encrypted" | "not-encrypted" | "unknown";

/**
 * Read the ZIP local-file-header general-purpose bit flag (bit 0 = encrypted).
 *
 * Deliberately header-only: this runs on the foreground path, so it inspects the
 * first record and nothing else. Formats without a cheap, reliable header signal
 * (7z / rar / dmg) report `unknown`, which callers must treat as uninspectable.
 */
export function zipEncryptionFromHeader(head: Uint8Array): ArchiveEncryption {
  if (head.length < 8) return "unknown";
  const isLocalFileHeader =
    head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (!isLocalFileHeader) return "unknown";
  const generalPurposeFlag = head[6]! | (head[7]! << 8);
  return (generalPurposeFlag & 0x0001) !== 0 ? "encrypted" : "not-encrypted";
}
