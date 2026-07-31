import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZipEntriesSafely } from "./safe-unzip.js";

// ---- Minimal ZIP builder (no external deps) -------------------------------

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

interface ZipSpec {
  name: string;
  /** Raw compressed bytes to embed (already deflate-raw or stored). */
  compressed: Buffer;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  /** Value written to the uncompressed-size fields (may deliberately lie). */
  uncompressedSize: number;
  versionMadeBy?: number;
  externalAttrs?: number;
}

function deflateSpec(name: string, content: Buffer, opts?: Partial<ZipSpec>): ZipSpec {
  const compressed = zlib.deflateRawSync(content);
  return {
    name,
    compressed,
    method: 8,
    uncompressedSize: content.length,
    ...opts,
  };
}

function storeSpec(name: string, content: Buffer, opts?: Partial<ZipSpec>): ZipSpec {
  return {
    name,
    compressed: content,
    method: 0,
    uncompressedSize: content.length,
    ...opts,
  };
}

function buildZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const s of specs) {
    const nameBuf = Buffer.from(s.name, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(s.method),
      u16(0), // time
      u16(0), // date
      u32(0), // crc (unchecked by reader)
      u32(s.compressed.length),
      u32(s.uncompressedSize),
      u16(nameBuf.length),
      u16(0), // extra len
      nameBuf,
      s.compressed,
    ]);
    const localOffset = offset;
    locals.push(local);
    offset += local.length;

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(s.versionMadeBy ?? 20),
      u16(20), // version needed
      u16(0), // flags
      u16(s.method),
      u16(0), // time
      u16(0), // date
      u32(0), // crc
      u32(s.compressed.length),
      u32(s.uncompressedSize),
      u16(nameBuf.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk start
      u16(0), // internal attrs
      u32(s.externalAttrs ?? 0),
      u32(localOffset),
      nameBuf,
    ]);
    centrals.push(central);
  }

  const centralDir = Buffer.concat(centrals);
  const centralStart = offset;
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk
    u16(0), // cd start disk
    u16(specs.length), // entries this disk
    u16(specs.length), // total entries
    u32(centralDir.length),
    u32(centralStart),
    u16(0), // comment len
  ]);

  return Buffer.concat([...locals, centralDir, eocd]);
}

// ---- Tests ----------------------------------------------------------------

describe("readZipEntriesSafely", () => {
  it("extracts only wanted entries from a normal archive (deflate + stored)", () => {
    const doc = Buffer.from("<document>hello</document>", "utf8");
    const core = Buffer.from("<coreProperties/>", "utf8");
    const zip = buildZip([
      deflateSpec("word/document.xml", doc),
      storeSpec("docProps/core.xml", core),
    ]);

    const res = readZipEntriesSafely(zip, (p) => p === "word/document.xml");

    expect(res.aborted).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.path).toBe("word/document.xml");
    expect(res.entries[0]!.data.equals(doc)).toBe(true);

    // Stored entries also decompress correctly when wanted.
    const both = readZipEntriesSafely(zip, () => true);
    expect(both.entries).toHaveLength(2);
    const stored = both.entries.find((e) => e.path === "docProps/core.xml")!;
    expect(stored.data.equals(core)).toBe(true);
  });

  it("skips path-traversal and absolute-path entries with a warning, keeps safe ones", () => {
    const payload = Buffer.from("data", "utf8");
    const zip = buildZip([
      deflateSpec("../../etc/evil.xml", payload),
      deflateSpec("/absolute/evil.xml", payload),
      deflateSpec("nested/../still-bad.xml", payload),
      deflateSpec("word/document.xml", payload),
    ]);

    const res = readZipEntriesSafely(zip, () => true);

    expect(res.aborted).toBe(false);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.path).toBe("word/document.xml");
    expect(res.warnings).toHaveLength(3);
    expect(res.warnings.every((w) => w.includes("unsafe path"))).toBe(true);
  });

  it("aborts safely on an entry whose declared compression ratio is too high", () => {
    const zeros = Buffer.alloc(10_000, 0);
    const zip = buildZip([deflateSpec("word/document.xml", zeros)]);

    const res = readZipEntriesSafely(zip, () => true, { maxRatio: 5 });

    expect(res.aborted).toBe(true);
    expect(res.abortReason).toContain("ratio");
    expect(res.entries).toHaveLength(0);
  });

  it("aborts safely on an entry whose declared size exceeds maxEntryBytes", () => {
    const payload = Buffer.from("small", "utf8");
    // Declare a huge uncompressed size while the real payload is tiny.
    const zip = buildZip([
      deflateSpec("word/document.xml", payload, { uncompressedSize: 1_000_000 }),
    ]);

    const res = readZipEntriesSafely(zip, () => true, { maxEntryBytes: 100 });

    expect(res.aborted).toBe(true);
    expect(res.abortReason).toContain("maxEntryBytes");
    expect(res.entries).toHaveLength(0);
  });

  it("aborts during decompression when a lying header hides a bomb (maxOutputLength)", () => {
    const zeros = Buffer.alloc(10_000, 0);
    // Under-report the uncompressed size so the declared-size checks pass, but
    // the real inflate output blows past the cap.
    const zip = buildZip([
      deflateSpec("word/document.xml", zeros, { uncompressedSize: 50 }),
    ]);

    const res = readZipEntriesSafely(zip, () => true, {
      maxEntryBytes: 5_000,
      maxRatio: 1_000_000,
    });

    expect(res.aborted).toBe(true);
    expect(res.abortReason).toContain("decompress");
    expect(res.entries).toHaveLength(0);
  });

  it("aborts when the entry count exceeds maxEntries", () => {
    const payload = Buffer.from("x", "utf8");
    const specs = Array.from({ length: 5 }, (_, i) =>
      deflateSpec(`f${i}.xml`, payload),
    );
    const zip = buildZip(specs);

    const res = readZipEntriesSafely(zip, () => true, { maxEntries: 3 });

    expect(res.aborted).toBe(true);
    expect(res.abortReason).toContain("maxEntries");
    expect(res.entries).toHaveLength(0);
  });

  it("skips symlink entries with a warning", () => {
    const payload = Buffer.from("../../target", "utf8");
    const unixSymlinkMode = (0xa000 << 16) >>> 0; // S_IFLNK in external attrs
    const zip = buildZip([
      deflateSpec("link", payload, {
        versionMadeBy: 3 << 8, // Unix host
        externalAttrs: unixSymlinkMode,
      }),
      deflateSpec("word/document.xml", Buffer.from("ok", "utf8")),
    ]);

    const res = readZipEntriesSafely(zip, () => true);

    expect(res.aborted).toBe(false);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.path).toBe("word/document.xml");
    expect(res.warnings.some((w) => w.includes("symlink"))).toBe(true);
  });

  it("returns an abort status (never throws) on malformed input", () => {
    const res = readZipEntriesSafely(Buffer.from("not a zip at all"), () => true);
    expect(res.aborted).toBe(true);
    expect(res.abortReason).toBeDefined();
    expect(res.entries).toHaveLength(0);
  });
});
