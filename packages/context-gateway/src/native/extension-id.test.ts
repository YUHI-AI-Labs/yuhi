import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { YUHI_EXTENSION_ID } from "./vscode-launcher.js";

/**
 * Marketplace extension identity guard (0.4.4).
 *
 * `yuhi-ai-labs.yuhi-vscode` was removed from the Marketplace. A removed extension
 * name is permanently reserved — "cannot be reused, even by the original publisher" —
 * so that id can never serve a release again. Reintroducing it anywhere would make
 * Native GUI resolve a listing that cannot exist, and it fails at install time rather
 * than at build time, which is exactly the kind of break a test should catch first.
 *
 * The id was hardcoded in three places when this change was made. It is now derived
 * from one constant everywhere, and this suite keeps it that way.
 */

const RETIRED_ID = "yuhi-ai-labs.yuhi-vscode";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

/** Source trees that ship. Build output and prepared fixtures are not sources. */
const SOURCE_DIRS = [
  "packages/context-gateway/src",
  "packages/core/src",
  "packages/shared/src",
  "apps/vscode/src",
  "apps/cli/src",
];

function sourceFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (/\.(?:ts|tsx|js|mjs)$/.test(entry)) out.push(p);
    }
  };
  try {
    walk(abs);
  } catch {
    /* a tree that does not exist contributes nothing */
  }
  return out;
}

describe("Marketplace extension identity", () => {
  it("is the post-0.4.4 id, not the retired one", () => {
    expect(YUHI_EXTENSION_ID).toBe("yuhi-ai-labs.yuhi-code");
    expect(YUHI_EXTENSION_ID).not.toBe(RETIRED_ID);
  });

  it("matches the extension manifest's publisher.name exactly", () => {
    // A drift here means the built VSIX and the id Yuhi installs disagree, so the
    // isolated window would install one extension and then look for another.
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "apps/vscode/package.json"), "utf8"),
    ) as { name: string; publisher: string };
    expect(`${manifest.publisher}.${manifest.name}`).toBe(YUHI_EXTENSION_ID);
  });

  it("never appears as a literal in shipped source — only via the constant", () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(dir)) {
        if (file.endsWith("extension-id.test.ts")) continue; // this file names it on purpose
        const text = readFileSync(file, "utf8");
        if (!text.includes(RETIRED_ID)) continue;
        // A comment explaining the history is fine; executable code is not.
        const offending = text
          .split("\n")
          .filter((line) => line.includes(RETIRED_ID))
          .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
        if (offending.length > 0) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${offending[0]!.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("builds a version-pinned ref from the constant", () => {
    // The shape Native GUI installs. If the id is wrong the pin is unresolvable.
    const ref = `${YUHI_EXTENSION_ID}@0.4.4`;
    expect(ref).toBe("yuhi-ai-labs.yuhi-code@0.4.4");
    expect(ref.startsWith(RETIRED_ID)).toBe(false);
  });
});
