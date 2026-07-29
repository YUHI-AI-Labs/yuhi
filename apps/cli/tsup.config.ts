import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  noExternal: [/^@yuhi\//],
  banner: { js: "#!/usr/bin/env node" },
});
