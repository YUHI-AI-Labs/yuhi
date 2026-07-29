import { createHmac } from "node:crypto";
export function verifyToken(token?: string): boolean {
  if (!token) return false;
  const [body, sig] = token.split(".");
  const expected = createHmac("sha256", process.env.JWT_SECRET ?? "").update(body).digest("hex");
  return sig === expected;
}
