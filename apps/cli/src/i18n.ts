import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Lang = "en" | "ja" | "zh-CN";
export const SUPPORTED_LANGS: Lang[] = ["en", "ja", "zh-CN"];

const localesDir = fileURLToPath(new URL("../locales/", import.meta.url));

function readLocale(lang: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path.join(localesDir, `${lang}.json`), "utf8"));
  } catch {
    return {};
  }
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Pick a language from an explicit flag or the environment (LANG/LC_ALL). */
export function resolveLang(explicit?: string): Lang {
  const candidate = (explicit ?? process.env.YUHI_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? "en")
    .toString()
    .toLowerCase();
  if (candidate.startsWith("ja")) return "ja";
  if (candidate.startsWith("zh")) return "zh-CN";
  return "en";
}

/** English is always the fallback base so no key is ever missing. */
export function createTranslator(lang: Lang): Translator {
  const base = readLocale("en");
  const overlay = lang === "en" ? {} : readLocale(lang);
  const messages = { ...base, ...overlay };
  return (key, params) => {
    let text = messages[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  };
}
