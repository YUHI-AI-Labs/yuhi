import { describe, expect, it } from "vitest";
import { extractPptx } from "./pptx-extract.js";

/* -------------------------------------------------------------------------- */
/* Minimal STORED (uncompressed) ZIP writer — produces a real OOXML container   */
/* that any conformant unzip (including safe-unzip's readZipEntriesSafely) reads.*/
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: string | Buffer;
}

function buildZip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBuf = Buffer.from(input.name, "utf8");
    const dataBuf = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data, "utf8");
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18); // compressed size
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);
    dataBuf.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* -------------------------------------------------------------------------- */
/* XML fixtures                                                                 */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;

function slideXml(opts: {
  title: string;
  bullets: string[];
  table?: string[][];
  hidden?: boolean;
}): string {
  const bulletParas = opts.bullets
    .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
    .join("");
  const tableXml = opts.table
    ? `<p:graphicFrame><a:tbl>${opts.table
        .map(
          (row) =>
            `<a:tr>${row
              .map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`)
              .join("")}</a:tr>`,
        )
        .join("")}</a:tbl></p:graphicFrame>`
    : "";
  const showAttr = opts.hidden ? ` show="0"` : "";
  return `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"${showAttr}><p:cSld><p:spTree>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${opts.title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:txBody>${bulletParas}</p:txBody></p:sp>` +
    tableXml +
    `</p:spTree></p:cSld></p:sld>`;
}

const NOTES_1 = `<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Remember to slow down &amp; breathe.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

function fullDeck(): Buffer {
  // Deliberately place slide2 BEFORE slide1 in the archive to exercise ordering.
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    {
      name: "ppt/slides/slide2.xml",
      data: slideXml({ title: "Appendix", bullets: ["Backup detail"], hidden: true }),
    },
    {
      name: "ppt/slides/slide1.xml",
      data: slideXml({
        title: "Quarterly Review",
        bullets: ["First bullet", "Second bullet"],
        table: [
          ["Region", "Total"],
          ["North", "42"],
        ],
      }),
    },
    { name: "ppt/notesSlides/notesSlide1.xml", data: NOTES_1 },
    { name: "ppt/media/image1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: "ppt/embeddings/oleObject1.bin", data: Buffer.from([0x00, 0x01]) },
    { name: "ppt/vbaProject.bin", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                        */
/* -------------------------------------------------------------------------- */

describe("extractPptx", () => {
  it("extracts slides in slide-number order regardless of archive order", async () => {
    const result = await extractPptx(fullDeck());
    expect(result.status).toBe("extracted");
    expect(result.ok).toBe(true);
    expect(result.slides.map((s) => s.title)).toEqual([
      "Quarterly Review",
      "Appendix",
    ]);
    expect(result.slides.map((s) => s.index)).toEqual([0, 1]);
  });

  it("extracts titles, body bullets and tables", async () => {
    const { slides } = await extractPptx(fullDeck());
    const first = slides[0]!;
    expect(first.title).toBe("Quarterly Review");
    expect(first.body).toEqual(["First bullet", "Second bullet"]);
    expect(first.tables).toEqual([
      [
        ["Region", "Total"],
        ["North", "42"],
      ],
    ]);
  });

  it("extracts and associates speaker notes with the right slide", async () => {
    const { slides } = await extractPptx(fullDeck());
    expect(slides[0]!.notes).toEqual(["Remember to slow down & breathe."]);
    expect(slides[1]!.notes).toEqual([]);
  });

  it("flags macros, embedded objects, images and hidden slides without executing them", async () => {
    const result = await extractPptx(fullDeck());
    expect(result.macroDetected).toBe(true);
    expect(result.embeddedObjectCount).toBe(1);
    expect(result.imageCount).toBe(1);
    expect(result.hiddenSlideCount).toBe(1);
    expect(result.warnings.some((w) => /macro/i.test(w))).toBe(true);
  });

  it("reports 'unsupported' for a zip that is not a PPTX package", async () => {
    const zip = buildZip([{ name: "hello.txt", data: "not a deck" }]);
    const result = await extractPptx(zip);
    expect(result.status).toBe("unsupported");
    expect(result.ok).toBe(false);
    expect(result.slides).toEqual([]);
  });

  it("returns status 'failed' on corrupt (non-zip) input without throwing", async () => {
    const result = await extractPptx(Buffer.from("this is definitely not a zip file"));
    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.slides).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
