import { describe, expect, it } from "vitest";
import { extractDocx } from "./docx-extract.js";

// ---------------------------------------------------------------------------
// Minimal, dependency-free ZIP writer (store method + CRC32) so tests can build
// real .docx bytes without adding a zip dependency. Produces a standard archive
// that any conformant unzip (including the module's safe-unzip) can read.
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

interface ZipInput {
  name: string;
  data: Buffer | string;
}

function makeZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), name, data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), name,
      ]),
    );
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function documentXml(inner: string): string {
  return `<?xml version="1.0"?><w:document ${NS}><w:body>${inner}</w:body></w:document>`;
}

function para(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function tableXml(): string {
  const cell = (t: string): string => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const emptyCell = "<w:tc><w:p></w:p></w:tc>";
  return (
    "<w:tbl>" +
    `<w:tr>${cell("A1")}${cell("B1")}</w:tr>` +
    `<w:tr>${cell("A2")}${emptyCell}</w:tr>` +
    "</w:tbl>"
  );
}

describe("extractDocx", () => {
  it("extracts title, body paragraphs, and excludes table text from paragraphs", async () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      {
        name: "word/document.xml",
        data: documentXml(para("First &amp; foremost") + tableXml() + para("Trailing line")),
      },
      {
        name: "docProps/core.xml",
        data: '<cp:coreProperties xmlns:dc="d"><dc:title>Sample Report</dc:title></cp:coreProperties>',
      },
    ]);

    const res = await extractDocx(zip);
    expect(res.status).toBe("extracted");
    expect(res.ok).toBe(true);
    expect(res.title).toBe("Sample Report");
    // Entity decoded, and table cells are NOT in paragraphs.
    expect(res.paragraphs).toEqual(["First & foremost", "Trailing line"]);
    expect(res.paragraphs.join(" ")).not.toContain("A1");
    expect(res.macroDetected).toBe(false);
  });

  it("parses a table into rows and cells, preserving empty cells", async () => {
    const zip = makeZip([
      { name: "word/document.xml", data: documentXml(tableXml()) },
    ]);
    const res = await extractDocx(zip);
    expect(res.tables).toEqual([[["A1", "B1"], ["A2", ""]]]);
  });

  it("detects a VBA macro project (word/vbaProject.bin) and warns", async () => {
    const zip = makeZip([
      { name: "word/document.xml", data: documentXml(para("body")) },
      { name: "word/vbaProject.bin", data: Buffer.from([0, 1, 2, 3]) },
    ]);
    const res = await extractDocx(zip);
    expect(res.status).toBe("extracted");
    expect(res.macroDetected).toBe(true);
    expect(res.warnings.some((w) => /macro/i.test(w))).toBe(true);
  });

  it("counts images and embedded objects, and detects tracked changes", async () => {
    const zip = makeZip([
      {
        name: "word/document.xml",
        data: documentXml('<w:p><w:ins id="1"><w:r><w:t>added</w:t></w:r></w:ins></w:p>'),
      },
      { name: "word/media/image1.png", data: Buffer.from([1]) },
      { name: "word/media/image2.jpeg", data: Buffer.from([2]) },
      { name: "word/embeddings/oleObject1.bin", data: Buffer.from([3]) },
    ]);
    const res = await extractDocx(zip);
    expect(res.imageCount).toBe(2);
    expect(res.embeddedObjectCount).toBe(1);
    expect(res.trackedChangesDetected).toBe(true);
    expect(res.paragraphs).toEqual(["added"]);
  });

  it("extracts headers/footers, footnotes, and comments", async () => {
    const zip = makeZip([
      { name: "word/document.xml", data: documentXml(para("main")) },
      { name: "word/header1.xml", data: `<w:hdr ${NS}>${para("Header text")}</w:hdr>` },
      { name: "word/footer1.xml", data: `<w:ftr ${NS}>${para("Footer text")}</w:ftr>` },
      {
        name: "word/footnotes.xml",
        data:
          `<w:footnotes ${NS}>` +
          `<w:footnote w:type="separator" w:id="-1"><w:p></w:p></w:footnote>` +
          `<w:footnote w:id="1">${para("A real footnote")}</w:footnote>` +
          "</w:footnotes>",
      },
      {
        name: "word/comments.xml",
        data: `<w:comments ${NS}><w:comment w:id="1">${para("Reviewer note")}</w:comment></w:comments>`,
      },
    ]);
    const res = await extractDocx(zip);
    expect(res.headersFooters).toContain("Header text");
    expect(res.headersFooters).toContain("Footer text");
    // Separator note (no text) dropped; real footnote kept.
    expect(res.footnotes).toEqual(["A real footnote"]);
    expect(res.comments).toEqual(["Reviewer note"]);
  });

  it("is robust to a non-default namespace prefix", async () => {
    const doc =
      '<?xml version="1.0"?><x:document xmlns:x="ns"><x:body>' +
      "<x:p><x:r><x:t>Prefixed</x:t></x:r><x:r><x:tab/></x:r><x:r><x:t>run</x:t></x:r></x:p>" +
      "</x:body></x:document>";
    const zip = makeZip([{ name: "word/document.xml", data: doc }]);
    const res = await extractDocx(zip);
    expect(res.status).toBe("extracted");
    expect(res.paragraphs).toEqual(["Prefixed run"]);
  });

  it("returns status 'failed' for a corrupt buffer without throwing", async () => {
    const corrupt = Buffer.from("this is not a zip archive at all, just noise".repeat(4), "utf8");
    const res = await extractDocx(corrupt);
    expect(res.status).toBe("failed");
    expect(res.ok).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("returns status 'failed' for an empty buffer", async () => {
    const res = await extractDocx(Buffer.alloc(0));
    expect(res.status).toBe("failed");
    expect(res.ok).toBe(false);
  });

  it("returns status 'unsupported' for a zip without word/document.xml", async () => {
    const zip = makeZip([{ name: "hello.txt", data: "not a docx" }]);
    const res = await extractDocx(zip);
    expect(res.status).toBe("unsupported");
    expect(res.ok).toBe(false);
    expect(res.warnings.some((w) => /document\.xml/.test(w))).toBe(true);
  });
});
