/**
 * Minimal .env parser for the "Runtime only" route: values are injected into the
 * agent's process environment, never placed in the context it reads.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface SanitizedDotenv {
  output: string;
  valuesProtected: number;
  configurationValuesPreserved: number;
}

const SENSITIVE_NAME =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL|DB_URL|CONNECTION_STRING)/i;
const SAFE_CONFIGURATION_NAME =
  /(?:^|_)(?:MODEL|PORT|DEBUG|LOG_LEVEL|NODE_ENV|APP_ENV|ENVIRONMENT|HOST|REGION|PROJECT|PROJECT_ID|APP_NAME|SERVICE_NAME|TIMEOUT|RETRIES|FEATURE_FLAG)(?:_|$)/i;

/**
 * Produce an agent-readable .env copy without credential values.
 * Unknown values fail closed; only clearly non-sensitive settings survive.
 */
export function sanitizeDotenv(text: string): SanitizedDotenv {
  let valuesProtected = 0;
  let configurationValuesPreserved = 0;
  const output = text.split(/\r?\n/).map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return rawLine;
    const eq = rawLine.indexOf("=");
    if (eq <= 0) return rawLine;
    const prefix = rawLine.slice(0, eq);
    const key = prefix.trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return rawLine;
    const value = rawLine.slice(eq + 1).trim();
    const safeValue =
      !SENSITIVE_NAME.test(key) &&
      SAFE_CONFIGURATION_NAME.test(key) &&
      value.length <= 256 &&
      !/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(value);
    if (safeValue) {
      configurationValuesPreserved += 1;
      return rawLine;
    }
    if (value.length > 0) valuesProtected += 1;
    return `${prefix}=\${${key}}`;
  }).join("\n");
  return { output, valuesProtected, configurationValuesPreserved };
}

function protectedValue(key: string): string {
  return `\${${key.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}}`;
}

/**
 * Sanitize JSON or simple YAML credential documents deterministically.
 * Throws when the input cannot be parsed safely; callers must then keep it local.
 */
export function sanitizeCredentialDocument(text: string): SanitizedDotenv {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown;
    let valuesProtected = 0;
    let configurationValuesPreserved = 0;
    const visit = (value: unknown, key = "VALUE"): unknown => {
      if (Array.isArray(value)) return value.map((item, index) => visit(item, `${key}_${index + 1}`));
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
            childKey,
            visit(child, childKey),
          ]),
        );
      }
      const safe = !SENSITIVE_NAME.test(key) && SAFE_CONFIGURATION_NAME.test(key);
      if (safe) {
        configurationValuesPreserved += 1;
        return value;
      }
      if (value !== null && value !== "") valuesProtected += 1;
      return protectedValue(key);
    };
    return {
      output: JSON.stringify(visit(parsed), null, 2) + "\n",
      valuesProtected,
      configurationValuesPreserved,
    };
  }

  let valuesProtected = 0;
  let configurationValuesPreserved = 0;
  let parsedScalars = 0;
  const output = text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return line;
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*:\s*)(.*)$/.exec(line);
    if (!match) {
      if (/^\s*[-{}[\]]/.test(line)) return line;
      throw new Error("Credential document could not be parsed safely.");
    }
    const [, indent = "", key = "", separator = ": ", rawValue = ""] = match;
    if (!rawValue.trim()) return line;
    parsedScalars += 1;
    const safe = !SENSITIVE_NAME.test(key) && SAFE_CONFIGURATION_NAME.test(key);
    if (safe) {
      configurationValuesPreserved += 1;
      return line;
    }
    valuesProtected += 1;
    return `${indent}${key}${separator}"${protectedValue(key)}"`;
  }).join("\n");
  if (parsedScalars === 0) throw new Error("Credential document contained no verifiable settings.");
  return { output, valuesProtected, configurationValuesPreserved };
}
