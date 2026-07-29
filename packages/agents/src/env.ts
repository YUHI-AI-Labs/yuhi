/**
 * Build the environment for a child agent process.
 *
 * THREAT_MODEL T7: we do NOT inherit the full parent environment (which may hold
 * unrelated secrets). We pass a minimal set of OS essentials plus ONLY the
 * variables the user explicitly allow-listed (e.g. ANTHROPIC_API_KEY).
 */
const POSIX_ESSENTIALS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TMPDIR", "USER", "LOGNAME"];
const WINDOWS_ESSENTIALS = [
  "Path",
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
  "windir",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

export function buildChildEnv(passthrough: string[] = []): NodeJS.ProcessEnv {
  const essentials = process.platform === "win32" ? WINDOWS_ESSENTIALS : POSIX_ESSENTIALS;
  const env: NodeJS.ProcessEnv = {};
  for (const key of essentials) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const key of passthrough) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // A marker so agents/hooks can detect they run inside a Yuhi context.
  env.YUHI_ACTIVE = "1";
  return env;
}

/** Names of env vars that were requested but are not set (for a friendly warning). */
export function missingPassthrough(passthrough: string[]): string[] {
  return passthrough.filter((k) => process.env[k] === undefined);
}
