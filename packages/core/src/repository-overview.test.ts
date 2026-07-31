import { describe, it, expect } from "vitest";
import { buildRepositoryOverview, formatRepositoryOverview } from "./repository-overview.js";

describe("buildRepositoryOverview", () => {
  const paths = [
    "apps/web/auth/login.ts", "apps/web/billing/invoice.ts", "src/api/routes.ts",
    "packages/db/client.ts", "packages/db/schema.ts",
    "tests/auth.test.ts", "src/api/api.spec.ts",
    "docs/architecture.md", "README.md",
    "package.json", ".eslintrc.json", "data/records.csv",
  ];
  it("groups deterministically into categories + top modules", () => {
    const o = buildRepositoryOverview(paths);
    const names = o.categories.map((c) => c.name);
    expect(names).toContain("Applications");
    expect(names).toContain("Libraries");
    expect(names).toContain("Tests");
    expect(names).toContain("Documentation");
    expect(names).toContain("Configuration");
    expect(o.totalFiles).toBe(paths.length);
    expect(o.topModules).toContain("db"); // module extracted one level (web/api/db), not deeply nested
    // Deterministic: same input -> same output.
    expect(buildRepositoryOverview(paths)).toEqual(o);
  });
  it("formats a readable overview", () => {
    const text = formatRepositoryOverview(buildRepositoryOverview(paths));
    expect(text).toContain("Repository Overview");
    expect(text).toContain("Top modules");
  });
});
