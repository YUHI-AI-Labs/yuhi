/**
 * Entry for the standalone `dist/typescript-runtime.js` bundle.
 *
 * esbuild bundles the whole `typescript` compiler into a single CJS module (typescript is
 * NOT external for this build). The VS Code extension `require()`s the built file on demand
 * — only when Context Compression is enabled — and injects it as
 * `globalThis.__yuhiTypeScriptRuntime` so the compressor uses this shipped runtime instead
 * of a bare `import("typescript")` that an installed VSIX (no node_modules) cannot resolve.
 */
import ts = require("typescript");

export = ts;
