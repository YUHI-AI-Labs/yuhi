/** Dev harness: run the Native GUI broker from source (the VSIX ships dist/native-broker.js). */
import { brokerMain } from "../packages/context-gateway/src/index.js";
brokerMain(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
