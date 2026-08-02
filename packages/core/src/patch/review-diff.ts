/** A public-safe diff representation. Sensitive spans have already been masked. */
export interface MaskedPatchDiff {
  relpath: string;
  before: string;
  after: string;
  maskedCategories: Array<"secret" | "personal-data">;
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const SECRET_TOKEN = /\b(?:AKIA[0-9A-Z]{16}|(?:sk-proj-|sk-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{16,})\b/g;
const SECRET_ASSIGNMENT = /((?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?)[^\s,"'}]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE = /\b(?:\+?\d[\s().-]*){10,15}\b/g;

function maskText(value: string): { value: string; categories: Set<"secret" | "personal-data"> } {
  const categories = new Set<"secret" | "personal-data">();
  const replace = (pattern: RegExp, category: "secret" | "personal-data", label: string) => {
    const next = value.replace(pattern, (...args: unknown[]) => {
      categories.add(category);
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return `${prefix}[${label}]`;
    });
    value = next;
  };
  replace(PRIVATE_KEY_BLOCK, "secret", "REDACTED SECRET");
  replace(SECRET_TOKEN, "secret", "REDACTED SECRET");
  replace(SECRET_ASSIGNMENT, "secret", "REDACTED SECRET");
  replace(EMAIL, "personal-data", "REDACTED PERSONAL DATA");
  replace(SSN, "personal-data", "REDACTED PERSONAL DATA");
  replace(PHONE, "personal-data", "REDACTED PERSONAL DATA");
  return { value, categories };
}

/**
 * Mask both sides before they cross the Core review boundary. Callers must
 * render this value, never the uninspected filesystem bytes.
 */
export function buildMaskedPatchDiff(
  relpath: string,
  beforeContent: string | Uint8Array | undefined,
  afterContent: string | Uint8Array | undefined,
): MaskedPatchDiff {
  const asText = (input: string | Uint8Array | undefined) =>
    input === undefined ? "" : typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const before = maskText(asText(beforeContent));
  const after = maskText(asText(afterContent));
  return {
    relpath,
    before: before.value,
    after: after.value,
    maskedCategories: [...new Set([...before.categories, ...after.categories])].sort(),
  };
}
