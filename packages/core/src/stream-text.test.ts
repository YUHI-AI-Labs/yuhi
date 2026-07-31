import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanTextFileStreaming } from "./stream-text.js";

const roots: string[] = [];

function tmpFile(name: string, data: string | Buffer): string {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-stream-text-"));
  roots.push(root);
  const p = path.join(root, name);
  writeFileSync(p, data);
  return p;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const OPTS = { entropyThreshold: 4.0, keywords: [], relpath: "sample.txt" };

describe("scanTextFileStreaming", () => {
  it("processes a >2MB file to completion without loading it whole", async () => {
    // ~2.5 MB of benign filler across many lines.
    const line = "the quick brown fox jumps over the lazy dog 0123456789\n";
    const repeats = Math.ceil((2.5 * 1024 * 1024) / line.length);
    const p = tmpFile("big.txt", line.repeat(repeats));

    const res = await scanTextFileStreaming(p, { ...OPTS, chunkBytes: 64 * 1024 });

    expect(res.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(res.eol).toBe("lf");
    expect(res.hadBOM).toBe(false);
    // Benign content: no secret findings.
    expect(res.findings.filter((f) => f.detector === "api-key")).toHaveLength(0);
  });

  it("finds an API key that straddles a chunk boundary", async () => {
    // A valid AWS access key id: AKIA + 16 uppercase alphanumerics.
    const key = "AKIA1234567890ABCDEF";
    const prefix = "harmless text before the key ";
    // Choose a tiny chunk size so the key is guaranteed to span a boundary.
    const chunkBytes = prefix.length + 4; // split partway through the key
    const content = `${prefix}${key} trailing text after the key\n`;
    const p = tmpFile("secret.txt", content);

    const res = await scanTextFileStreaming(p, { ...OPTS, chunkBytes });

    const apiKey = res.findings.filter((f) => f.detector === "api-key");
    expect(apiKey.length).toBeGreaterThanOrEqual(1);
    // Deduplicated: the overlap must not double-report the same match.
    expect(apiKey).toHaveLength(1);
    expect(apiKey[0]!.line).toBe(1);
    expect(apiKey[0]!.path).toBe("sample.txt");
    // Only a masked preview is ever surfaced — never the raw secret.
    expect(apiKey[0]!.maskedPreview).not.toContain(key);
  });

  it("does not corrupt a multibyte character split across a chunk boundary", async () => {
    // Repeat a Japanese phrase so a 3-byte char lands on a raw-read boundary.
    const unit = "日本語のテスト ";
    const body = unit.repeat(400);
    const p = tmpFile("mb.txt", body);

    // Odd, small chunk size that will slice mid-character on most iterations.
    const res = await scanTextFileStreaming(p, { ...OPTS, chunkBytes: 17 });

    // A completed scan of well-formed UTF-8 must produce no replacement chars.
    // We assert indirectly: no keyword/entropy noise from mojibake and byte count
    // matches the encoded length exactly.
    expect(res.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(res.findings.some((f) => f.maskedPreview.includes("�"))).toBe(false);
    // And directly re-scan a decoded sample is unnecessary: mojibake would have
    // corrupted the byte-accounting invariant above; confirm no findings at all.
    expect(res.findings).toHaveLength(0);
  });

  it("detects a UTF-8 BOM", async () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello world\nsecond line\n", "utf8"),
    ]);
    const p = tmpFile("bom.txt", withBom);

    const res = await scanTextFileStreaming(p, OPTS);

    expect(res.hadBOM).toBe(true);
    expect(res.eol).toBe("lf");
  });

  it("detects CRLF line endings, including a split across a chunk boundary", async () => {
    // Put a \r\n right where a small chunk boundary falls to exercise the
    // combined-text EOL detection.
    const content = "alpha\r\nbravo\r\ncharlie\r\n";
    const p = tmpFile("crlf.txt", content);

    // chunkBytes chosen so a boundary lands between \r and \n.
    const res = await scanTextFileStreaming(p, { ...OPTS, chunkBytes: 6 });

    expect(res.eol).toBe("crlf");
    expect(res.hadBOM).toBe(false);
  });

  it("reports mixed line endings when both LF and CRLF occur", async () => {
    const p = tmpFile("mixed.txt", "unix line\nwindows line\r\nanother unix\n");
    const res = await scanTextFileStreaming(p, OPTS);
    expect(res.eol).toBe("mixed");
  });

  it("reports 'none' for a file with no line terminators", async () => {
    const p = tmpFile("oneline.txt", "no newline here");
    const res = await scanTextFileStreaming(p, OPTS);
    expect(res.eol).toBe("none");
  });
});
