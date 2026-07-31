import { build, context } from "esbuild";

/**
 * Bundle the extension (CJS — VS Code loads CommonJS). `vscode` AND `typescript` stay
 * external, so the TypeScript compiler is NEVER inlined into extension.js and the
 * extension bundle stays lean. The structure compressor never depends on an installed
 * `typescript`: at runtime the extension lazily loads the sibling `dist/typescript-runtime.js`
 * bundle (built below) and injects it via `globalThis.__yuhiTypeScriptRuntime`, which the
 * core loader (`packages/core/src/compression/typescript-compressor.ts`) prefers over a bare
 * `import("typescript")`. The runtime bundle is only required when Context Compression is on,
 * so a normal prepare loads nothing extra and activation stays fast.
 */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "typescript"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

/**
 * Second bundle: the TypeScript compiler as a self-contained CJS module. `typescript` is
 * NOT external here, so esbuild bundles the whole compiler (~9–10MB) into a single file
 * that ships in the VSIX. It is loaded ONLY on demand (compression on) via a computed
 * `require(path.join(__dirname, "typescript-runtime.js"))` in the extension — never at
 * activation. Ship ONLY this generated bundle; node_modules/typescript is never packaged.
 */
const tsRuntimeOptions = {
  entryPoints: ["src/typescript-runtime-entry.ts"],
  bundle: true,
  outfile: "dist/typescript-runtime.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const extensionCtx = await context(extensionOptions);
  const tsRuntimeCtx = await context(tsRuntimeOptions);
  await Promise.all([extensionCtx.watch(), tsRuntimeCtx.watch()]);
  console.log("watching…");
} else {
  await Promise.all([build(extensionOptions), build(tsRuntimeOptions)]);
}
