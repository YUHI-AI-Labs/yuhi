import { createServer } from "node:http";
import { router } from "./api.js";
export function start(port: number) {
  const server = createServer((req, res) => router(req, res));
  server.listen(port, () => console.log(`listening on :${port}`));
  return server;
}
