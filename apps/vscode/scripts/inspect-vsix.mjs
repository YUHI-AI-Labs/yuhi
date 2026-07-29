import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const vsix = path.resolve(process.argv[2] ?? "yuhi.vsix");
const list = spawnSync("unzip", ["-Z1", vsix], { encoding: "utf8" });
if (list.status !== 0) throw new Error(list.stderr || "Unable to list VSIX.");
const entries = list.stdout.trim().split(/\r?\n/).filter(Boolean);

const forbidden = [
  /(^|\/)\.yuhi(\/|$)/,
  /(^|\/)yuhi\.yaml$/,
  /(^|\/)\.env(?:\.[^/]*)?$/,
  /(^|\/)HANDOFF\.md$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(src|tests?|fixtures?)(\/|$)/,
  /\.map$/,
];
const suspiciousEntries = entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry)));
if (suspiciousEntries.length > 0) {
  throw new Error(`Forbidden VSIX entries:\n${suspiciousEntries.join("\n")}`);
}

for (const required of [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/media/yuhi-ai-labs-icon.png",
]) {
  if (!entries.includes(required)) throw new Error(`Missing required runtime asset: ${required}`);
}

const content = spawnSync("unzip", ["-p", vsix], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (content.status !== 0) throw new Error(content.stderr || "Unable to inspect VSIX content.");
const suspiciousContent = [
  /\/Users\//,
  /\/home\/[^/\s]+/,
  /AKIA[0-9A-Z]{12,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
].filter((pattern) => pattern.test(content.stdout));
if (suspiciousContent.length > 0) {
  throw new Error(`Suspicious VSIX content matched: ${suspiciousContent.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      vsix,
      sizeBytes: statSync(vsix).size,
      fileCount: entries.length,
      entries,
      suspiciousEntries: [],
      suspiciousContent: [],
    },
    null,
    2,
  ),
);
