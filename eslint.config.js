// Flat ESLint config (ESLint 9). Kept intentionally light for the MVP: correctness
// over style. Prettier owns formatting.
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/coverage/**",
      "examples/**",
      "benchmarks/**",
      ".yuhi/**",
    ],
  },
  js.configs.recommended,
  {
    // Node build scripts (.mjs) — allow Node globals.
    files: ["**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", __dirname: "readonly" },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: { process: "readonly", console: "readonly" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript's own checker handles undefined names & Node globals; the
      // core `no-undef` rule misfires on types like NodeJS / Buffer / URL.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
];
