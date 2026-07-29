import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The CLI's release version — the SINGLE authoritative source, read from this
 * package's own package.json at runtime. Works when bundled (dist/index.js sits
 * next to package.json in the published tarball), in dev (tsx), and in tests.
 * No separate hard-coded constant to drift out of date.
 */
export function cliVersion(): string {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
