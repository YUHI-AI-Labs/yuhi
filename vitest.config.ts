import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds apps/cli ONCE before any test file starts — several CLI tests spawn the
    // built binary as a real subprocess; each used to build in its own `beforeAll`,
    // which raced across vitest's parallel per-file workers (see the file's own doc
    // comment).
    globalSetup: ["./vitest.global-setup.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    // Security/integration tests touch the real filesystem in temp dirs; run serially
    // within a file to avoid cross-test interference.
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
