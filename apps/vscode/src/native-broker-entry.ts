/**
 * VSIX-bundled broker entry.
 *
 * Bundled as its own self-contained CJS file so the extension can spawn it with plain
 * `node dist/native-broker.js <config.json>`. It must not import `vscode`: by the time it
 * runs it is an ordinary Node process that outlives the extension host which started it.
 */

import { brokerMain } from "@yuhi/context-gateway";

brokerMain(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`broker failed: ${err instanceof Error ? err.message : "unknown"}\n`);
  process.exit(1);
});
