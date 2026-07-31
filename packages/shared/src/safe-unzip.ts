import zlib from "node:zlib";

/**
 * Resource limits for {@link readZipEntriesSafely}. All values are inclusive
 * caps; exceeding any of them aborts extraction (see abortReason).
 */
export interface UnzipLimits {
  /** Maximum number of entries declared in the central directory. */
  maxEntries: number;
  /** Maximum cumulative decompressed bytes across all extracted entries. */
  maxTotalBytes: number;
  /** Maximum decompressed bytes for any single entry. */
  maxEntryBytes: number;
  /** Maximum decompressed/compressed size ratio for any single entry. */
  maxRatio: number;
}

export interface SafeUnzipResult {
  /** Decompressed entries whose path satisfied `wanted`, in central-directory order. */
  entries: { path: string; data: Buffer }[];
  /** Non-fatal notes: skipped unsafe/symlink entries, etc. */
  warnings: string[];
  /** True when a limit was hit or the archive was malformed; extraction stopped. */
  aborted: boolean;
  /** Human-readable reason when `aborted` is true. */
  abortReason?: string;
}

export const DEFAULT_UNZIP_LIMITS: UnzipLimits = {
  maxEntries: 4096,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxRatio: 200,
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Reject absolute paths and path traversal. ZIP paths use forward slashes but
 * we also normalize backslashes defensively.
 */
function isUnsafePath(p: string): boolean {
  if (p.length === 0) return true;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  // Windows drive-letter absolute path e.g. "C:\foo".
  if (/^[a-zA-Z]:/.test(p)) return true;
  const segments = p.replace(/\\/g, "/").split("/");
  for (const seg of segments) {
    if (seg === "..") return true;
  }
  return false;
}

/** Detect a symlink from the Unix mode packed in external file attributes. */
function isSymlink(versionMadeBy: number, externalAttrs: number): boolean {
  const hostSystem = (versionMadeBy >> 8) & 0xff;
  // Only Unix hosts (3) carry a meaningful mode in the high 16 bits.
  if (hostSystem !== 3) return false;
  const mode = (externalAttrs >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000; // S_IFLNK
}

function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_MIN_SIZE) return -1;
  const scanStart = buf.length - EOCD_MIN_SIZE;
  const scanEnd = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = scanStart; i >= scanEnd; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

interface CentralEntry {
  path: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  versionMadeBy: number;
  externalAttrs: number;
}

/**
 * ZIP-bomb-safe reader for OOXML containers (docx/pptx/xlsx are ZIP files).
 *
 * Parses the central directory itself and uses only Node's zlib (no third-party
 * deps). Only entries for which `wanted(path)` returns true are decompressed.
 * Never recurses into nested archives, never executes anything, never touches
 * the filesystem. Expected-bad input (corrupt, oversized, traversal, high-ratio)
 * is represented as a status — this function does not throw for such input.
 */
export function readZipEntriesSafely(
  zip: Buffer,
  wanted: (path: string) => boolean,
  limits?: Partial<UnzipLimits>,
): SafeUnzipResult {
  const lim: UnzipLimits = { ...DEFAULT_UNZIP_LIMITS, ...limits };
  const result: SafeUnzipResult = { entries: [], warnings: [], aborted: false };

  const abort = (reason: string): SafeUnzipResult => {
    result.aborted = true;
    result.abortReason = reason;
    return result;
  };

  try {
    if (!Buffer.isBuffer(zip) || zip.length < EOCD_MIN_SIZE) {
      return abort("not a valid zip archive");
    }

    const eocd = findEocd(zip);
    if (eocd < 0) return abort("end-of-central-directory record not found");

    const totalEntries = zip.readUInt16LE(eocd + 10);
    const centralOffset = zip.readUInt32LE(eocd + 16);

    if (totalEntries === ZIP64_U16 || centralOffset === ZIP64_U32) {
      return abort("zip64 archives are not supported");
    }
    if (totalEntries > lim.maxEntries) {
      return abort(`entry count ${totalEntries} exceeds maxEntries ${lim.maxEntries}`);
    }
    if (centralOffset >= zip.length) {
      return abort("central directory offset out of range");
    }

    // Pass 1: parse the central directory into metadata.
    const central: CentralEntry[] = [];
    let ptr = centralOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (ptr + 46 > zip.length) return abort("truncated central directory");
      if (zip.readUInt32LE(ptr) !== SIG_CENTRAL) {
        return abort("bad central directory signature");
      }
      const versionMadeBy = zip.readUInt16LE(ptr + 4);
      const method = zip.readUInt16LE(ptr + 10);
      const compressedSize = zip.readUInt32LE(ptr + 20);
      const uncompressedSize = zip.readUInt32LE(ptr + 24);
      const nameLen = zip.readUInt16LE(ptr + 28);
      const extraLen = zip.readUInt16LE(ptr + 30);
      const commentLen = zip.readUInt16LE(ptr + 32);
      const externalAttrs = zip.readUInt32LE(ptr + 38);
      const localOffset = zip.readUInt32LE(ptr + 42);

      const nameStart = ptr + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > zip.length) return abort("truncated central directory entry name");
      const path = zip.toString("utf8", nameStart, nameEnd);

      central.push({
        path,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
        versionMadeBy,
        externalAttrs,
      });

      ptr = nameEnd + extraLen + commentLen;
    }

    // Pass 2: decompress wanted entries, enforcing limits.
    let totalBytes = 0;
    for (const entry of central) {
      // Directory entries (trailing slash) never carry payload.
      if (entry.path.endsWith("/")) continue;

      if (isUnsafePath(entry.path)) {
        result.warnings.push(`skipped unsafe path: ${entry.path}`);
        continue;
      }
      if (isSymlink(entry.versionMadeBy, entry.externalAttrs)) {
        result.warnings.push(`skipped symlink entry: ${entry.path}`);
        continue;
      }
      if (!wanted(entry.path)) continue;

      if (entry.uncompressedSize > lim.maxEntryBytes) {
        return abort(
          `entry ${entry.path} declares ${entry.uncompressedSize} bytes, exceeds maxEntryBytes ${lim.maxEntryBytes}`,
        );
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > lim.maxRatio
      ) {
        return abort(
          `entry ${entry.path} compression ratio exceeds maxRatio ${lim.maxRatio}`,
        );
      }

      const remainingBudget = lim.maxTotalBytes - totalBytes;
      if (entry.uncompressedSize > remainingBudget) {
        return abort(
          `entry ${entry.path} would exceed maxTotalBytes ${lim.maxTotalBytes}`,
        );
      }

      // Locate the compressed payload via the local file header.
      const lo = entry.localOffset;
      if (lo + 30 > zip.length || zip.readUInt32LE(lo) !== SIG_LOCAL) {
        return abort(`bad local header for ${entry.path}`);
      }
      const localNameLen = zip.readUInt16LE(lo + 26);
      const localExtraLen = zip.readUInt16LE(lo + 28);
      const dataStart = lo + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > zip.length) {
        return abort(`truncated payload for ${entry.path}`);
      }
      const compressed = zip.subarray(dataStart, dataEnd);

      // Cap decompression output regardless of declared sizes, so a lying
      // header cannot force a huge allocation.
      const outputCap = Math.min(lim.maxEntryBytes, remainingBudget);

      let data: Buffer;
      try {
        if (entry.method === METHOD_STORE) {
          if (compressed.length > outputCap) {
            return abort(`stored entry ${entry.path} exceeds size cap`);
          }
          data = Buffer.from(compressed);
        } else if (entry.method === METHOD_DEFLATE) {
          data = zlib.inflateRawSync(compressed, { maxOutputLength: outputCap });
        } else {
          result.warnings.push(
            `skipped entry with unsupported compression method ${entry.method}: ${entry.path}`,
          );
          continue;
        }
      } catch (err) {
        // RangeError from maxOutputLength, or corrupt deflate stream.
        const msg = err instanceof Error ? err.message : String(err);
        return abort(`failed to decompress ${entry.path}: ${msg}`);
      }

      // Re-check the actual (post-inflate) size against the ratio cap in case
      // the declared metadata under-reported the real expansion.
      if (
        compressed.length > 0 &&
        data.length / compressed.length > lim.maxRatio
      ) {
        return abort(
          `entry ${entry.path} actual compression ratio exceeds maxRatio ${lim.maxRatio}`,
        );
      }

      totalBytes += data.length;
      if (totalBytes > lim.maxTotalBytes) {
        return abort(`extraction exceeded maxTotalBytes ${lim.maxTotalBytes}`);
      }

      result.entries.push({ path: entry.path, data });
    }

    return result;
  } catch (err) {
    // Any unexpected parse error is surfaced as a status, never thrown.
    const msg = err instanceof Error ? err.message : String(err);
    return abort(`malformed zip archive: ${msg}`);
  }
}
