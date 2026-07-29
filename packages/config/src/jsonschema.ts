import { zodToJsonSchema } from "zod-to-json-schema";
import { yuhiConfigSchema } from "./schema.js";

/** Produce the JSON Schema published as schemas/yuhi.schema.json. */
export function toJsonSchema(): Record<string, unknown> {
  // Cast avoids a very deep generic instantiation in zod-to-json-schema that
  // trips `TS2589` under some consumer tsconfigs; the runtime behavior is unchanged.
  const schema = zodToJsonSchema(yuhiConfigSchema as never, {
    name: "YuhiConfig",
    $refStrategy: "none",
  });
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Yuhi configuration (yuhi.yaml)",
    ...(schema as Record<string, unknown>),
  };
}
