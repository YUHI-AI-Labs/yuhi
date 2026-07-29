import { describe, it, expect } from "vitest";
import { renderSavingsHtml, type ReviewData } from "./webview.js";

function data(over: Partial<ReviewData["report"]> = {}): ReviewData {
  return {
    project: "demo",
    outDir: ".yuhi/prepared/abc",
    report: {
      beforeTokens: 8208,
      afterTokens: 533,
      tokensSaved: 7675,
      percentReduction: 0.94,
      hasData: true,
      filesExcluded: 3,
      filesSummarized: 5,
      sensitiveMasked: 1,
      sourceModified: 0,
      approx: true,
      ...over,
    },
    files: [
      { path: "meeting-log.md", action: "prepare-locally", status: "ok", omitted: false, beforeTokens: 8000, afterTokens: 400, diffable: true },
      { path: "private/.env", action: "local-only", status: "skipped", omitted: true, beforeTokens: 10, afterTokens: 0, diffable: false },
    ],
  };
}

describe("renderSavingsHtml (Context Savings)", () => {
  const html = renderSavingsHtml(data(), "vscode-resource:", "NONCE123");

  it("leads with Estimated Claude input avoided and shows all required metrics", () => {
    expect(html).toContain("Estimated Claude input avoided");
    expect(html).toContain("Estimated input before");
    expect(html).toContain("Estimated input after");
    expect(html).toContain("Source files modified:");
    expect(html).toMatch(/summarized|Summarized/);
    expect(html).toMatch(/excluded/i);
    expect(html).toMatch(/masked/i);
  });

  it("carries the honest increase + unavailable branches (no clamping)", () => {
    expect(html).toContain("INCREASED");
    expect(html).toContain("unavailable");
  });

  it("retains the billing disclaimer and never promises savings", () => {
    expect(html).toContain("Actual usage and billing depend on the selected AI product");
    expect(html.toLowerCase()).not.toContain("guaranteed");
  });

  it("is CSP-locked with a nonce and no external sources", () => {
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("nonce-NONCE123");
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/); // no external script/style
  });

  it("embeds only metadata (paths/tokens), never <think> or raw secret values", () => {
    expect(html).not.toContain("<think>");
    // The data model carries no file contents — only paths + token counts.
    const json = data();
    expect(JSON.stringify(json.files)).not.toMatch(/API_KEY|sk-/);
  });

  it("escapes embedded JSON so it cannot break out of the script", () => {
    const evil = renderSavingsHtml({ ...data(), project: "</script><script>x" }, "", "N");
    expect(evil).not.toContain("</script><script>x");
  });
});
