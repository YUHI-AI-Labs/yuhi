#!/usr/bin/env node
/**
 * generate-locale-routes.mjs
 *
 * `site/index.html` is the ONLY editable source. Localization happens at
 * runtime: the page reads `location.pathname` and swaps text from a shared
 * locale dictionary. To make `/ja` and `/zh-cn` resolve reliably on Vercel
 * (static hosting, no rewrites), we ship byte-identical copies of the source
 * at those paths.
 *
 * These copies are DEPLOYMENT ARTIFACTS — never edit them by hand.
 * Run this script before every production deploy.
 *
 * Deterministic and safe to rerun. Exits non-zero if the source is missing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(siteDir, "index.html");
const LOCALES = ["en", "zh-cn"];

if (!existsSync(source)) {
  console.error(`[generate-locale-routes] ERROR: source not found: ${source}`);
  process.exit(1);
}

const html = readFileSync(source); // Buffer → byte-identical copies
const written = [];
for (const loc of LOCALES) {
  const dir = join(siteDir, loc);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "index.html");
  writeFileSync(dest, html);
  written.push(dest);
}

console.log(`[generate-locale-routes] source: ${source}`);
for (const p of written) console.log(`[generate-locale-routes] wrote:  ${p}`);
console.log(`[generate-locale-routes] ${written.length} locale route(s) generated from a single source.`);
