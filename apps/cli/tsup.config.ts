import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  noExternal: [/^@yuhi\//],
  // The shebang must stay first. The createRequire line makes esbuild's ESM
  // `__require` shim resolve to a real `require` (it checks `typeof require`),
  // so bundled CJS deps that `require()` Node builtins (e.g. ExcelJS →
  // `require("crypto")`) work instead of throwing "Dynamic require ... not supported".
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __yuhiCreateRequire } from 'node:module';\nconst require = __yuhiCreateRequire(import.meta.url);",
  },
});
