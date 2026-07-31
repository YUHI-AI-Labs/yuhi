import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  noExternal: [/^@yuhi\//],
  // `typescript` (12 MB, CJS) is loaded only when a file is actually compressed, via a
  // cached dynamic import in the structure compressor. Keep it external so it is never
  // inlined into the ESM CLI bundle; it is an optional dependency and gracefully absent.
  external: ["typescript"],
  // The shebang must stay first. The createRequire line makes esbuild's ESM
  // `__require` shim resolve to a real `require` (it checks `typeof require`),
  // so bundled CJS deps that `require()` Node builtins (e.g. ExcelJS →
  // `require("crypto")`) work instead of throwing "Dynamic require ... not supported".
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __yuhiCreateRequire } from 'node:module';\nconst require = __yuhiCreateRequire(import.meta.url);",
  },
});
