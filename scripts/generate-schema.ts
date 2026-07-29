/**
 * Generate schemas/yuhi.schema.json from the Zod config schema so editors can
 * validate & autocomplete yuhi.yaml. Run with: pnpm schema
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJsonSchema } from "@yuhi/config";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const outDir = path.join(root, "schemas");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "yuhi.schema.json");
writeFileSync(outPath, JSON.stringify(toJsonSchema(), null, 2) + "\n");
console.log(`Wrote ${path.relative(root, outPath)}`);
