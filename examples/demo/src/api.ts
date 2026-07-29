import { getUser, listOrders } from "./db.js";
import { verifyToken } from "./auth.js";
export function router(req: any, res: any) {
  const token = req.headers["authorization"];
  if (!verifyToken(token)) { res.statusCode = 401; return res.end("unauthorized"); }
  if (req.url === "/user") return res.end(JSON.stringify(getUser()));
  if (req.url === "/orders") return res.end(JSON.stringify(listOrders()));
  res.statusCode = 404; res.end("not found");
}
