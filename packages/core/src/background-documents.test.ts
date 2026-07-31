import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DocumentInspector, LocalModelProvider } from "@yuhi/shared";
import { prepareDocumentsInBackground } from "./background-documents.js";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-background-docs-"));
  roots.push(root);
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs/guide.pdf"), "%PDF-1.7 synthetic");
  return root;
}

function inspector(text: string): DocumentInspector {
  return {
    canInspect: () => true,
    async inspect(_file, consume) {
      consume(text);
      return {
        status: "inspected",
        extractedTextAvailable: true,
        extractionMethod: "pdf-text",
        pageCount: 2,
        warnings: [],
      };
    },
  };
}

function provider(output: string): LocalModelProvider {
  return {
    id: "synthetic",
    endpoint: "local",
    defaultModel: "synthetic",
    health: async () => ({ ok: true, detail: "ok", endpoint: "local" }),
    listModels: async () => ["synthetic"],
    generate: async () => output,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("background document preparation", () => {
  it("updates context from the Prepared Workspace copy without persisting extracted text", async () => {
    const root = fixture();
    const extracted = "Synthetic architecture guidance for a local application.";
    const events: string[] = [];
    const result = await prepareDocumentsInBackground(root, {
      relpaths: ["docs/guide.pdf"],
      documentInspector: inspector(extracted),
      providerFactory: () => provider("A concise architecture summary."),
      enrichWithOllama: true, // opt in: this test exercises the Phase-3 summary path
      onProgress: ({ phase }) => events.push(phase),
    });
    expect(result).toMatchObject({
      inspected: 1,
      summariesCreated: 1,
      summariesRejected: 0,
      sensitiveDocuments: 0,
    });
    expect(result.documents).toMatchObject([
      { relpath: "docs/guide.pdf", inspection: "pdf-text", summary: "created" },
    ]);
    const index = readFileSync(path.join(root, ".yuhi/context/document-index.md"), "utf8");
    expect(index).toContain("Status: Available");
    expect(index).toContain("Summary: Created");
    expect(index).not.toContain(extracted);
    expect(events).toContain("complete");
  });

  it("inspects documents WITHOUT calling Ollama by default (enrichment disabled)", async () => {
    const root = fixture();
    let modelCalls = 0;
    const result = await prepareDocumentsInBackground(root, {
      relpaths: ["docs/guide.pdf"],
      documentInspector: inspector("Synthetic architecture guidance."),
      providerFactory: () => ({
        ...provider("unused"),
        generate: async () => {
          modelCalls += 1;
          return "unused";
        },
      }),
      // enrichWithOllama omitted => default false
    });
    // The document is fully inspected (extract + rule scan) but the local model is
    // never invoked, and no summary is produced — the workspace stays usable.
    expect(result.inspected).toBe(1);
    expect(result.summariesCreated).toBe(0);
    expect(modelCalls).toBe(0);
    const index = readFileSync(path.join(root, ".yuhi/context/document-index.md"), "utf8");
    expect(index).toContain("Status: Available");
  });

  it("skips a document that exceeds the per-document timeout instead of hanging", async () => {
    const root = fixture();
    const hangingInspector: DocumentInspector = {
      canInspect: () => true,
      inspect: () => new Promise(() => {}), // never resolves — simulates a wedged tool
    };
    const result = await prepareDocumentsInBackground(root, {
      relpaths: ["docs/guide.pdf"],
      documentInspector: hangingInspector,
      providerFactory: () => provider("unused"),
      perDocumentTimeoutMs: 30,
    });
    expect(result.documents).toMatchObject([
      { relpath: "docs/guide.pdf", inspection: "incomplete", summary: "not-added" },
    ]);
    expect(result.summariesCreated).toBe(0);
  });

  it("inspects multiple documents concurrently to finish faster", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "yuhi-background-docs-"));
    roots.push(root);
    mkdirSync(path.join(root, "docs"), { recursive: true });
    const rels: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const rel = `docs/doc${i}.pdf`;
      writeFileSync(path.join(root, rel), "%PDF-1.7 synthetic");
      rels.push(rel);
    }
    let active = 0;
    let peak = 0;
    const slow: DocumentInspector = {
      canInspect: () => true,
      async inspect(_file, consume) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        consume("Synthetic architecture guidance.");
        return {
          status: "inspected",
          extractedTextAvailable: true,
          extractionMethod: "pdf-text",
          warnings: [],
        };
      },
    };
    const result = await prepareDocumentsInBackground(root, {
      relpaths: rels,
      documentInspector: slow,
      providerFactory: () => provider("A concise summary."),
      inspectionConcurrency: 3,
    });
    expect(result.inspected).toBe(4);
    expect(peak).toBeGreaterThan(1); // genuinely ran in parallel, not one-at-a-time
  });

  it("does not create a summary when inspection finds sensitive content", async () => {
    const root = fixture();
    let modelCalls = 0;
    const sensitive = "OPENAI_API_KEY=sk-synthetic-background-value";
    const result = await prepareDocumentsInBackground(root, {
      relpaths: ["docs/guide.pdf"],
      documentInspector: inspector(sensitive),
      providerFactory: () => ({
        ...provider("not used"),
        generate: async () => {
          modelCalls += 1;
          return "not used";
        },
      }),
    });
    expect(result.sensitiveDocuments).toBe(1);
    expect(modelCalls).toBe(0);
    const context = readFileSync(path.join(root, ".yuhi/context/document-index.md"), "utf8");
    expect(context).toContain("Summary: Not added");
    expect(context).not.toContain(sensitive);
  });
});
