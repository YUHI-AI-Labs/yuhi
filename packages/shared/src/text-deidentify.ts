import {
  DEFAULT_PRIVACY_MODE,
  modeTransformsDirectIdentifiers,
  type PrivacyMode,
} from "./identifier-taxonomy.js";
import {
  createStudentAliasContext,
  directPersonalValueTokensForEntities,
  entitiesReachableInText,
  mintUnlinkedPersonalToken,
  normalizeIdentifierValue,
  type StudentAliasContext,
} from "./student-records.js";

/**
 * Prose de-identification for document text (PDF / DOCX / PPTX extractions).
 *
 * Documents used to take a separate path: their pseudonymizer called
 * `extractTabularIdentifiers`, which needs a delimited table, so extracted prose threw,
 * the catch returned an empty forbidden list, and the raw extraction was published as a
 * "Verified companion" (issue #21). This module puts documents on the SAME policy as
 * tables — same taxonomy, same run registry, same verification.
 *
 * What it does, stated plainly because the distinction is the whole point of the
 * identity linkage policy (`docs/design/0.4.7_document_privacy.md`):
 *
 *   - Structured direct identifiers (email, phone, MyNumber, passport, bank account,
 *     card number) have detectable shapes and are always masked.
 *   - A value already registered in this run's tabular data — typically a person's
 *     name — reuses the SAME token the table used, but ONLY when the document ALSO
 *     contains a strong business key (student id, …) that resolves to that entity
 *     (`entitiesReachableInText`). A bare name match is NOT sufficient evidence of
 *     identity: merging two different people named 山田太郎 onto one token is data
 *     corruption, not anonymisation.
 *   - A CJK name-shaped candidate with NO such key is still masked — with a fresh,
 *     run-unique token, reused consistently within this one call — but is deliberately
 *     NOT linked to any existing entity. Masking without linking is the safe default;
 *     leaving it raw because it could not be linked is not an option.
 *
 * Known coverage gap, stated rather than hidden: the name heuristic
 * (`CJK_NAMEISH`) only recognizes 2–4 character CJK sequences. A single-character
 * surname, a name of 5+ characters, or a non-CJK (e.g. Latin-script) personal name in
 * prose is not detected by this function at all — there is no per-call signal for this,
 * because it is a property of the algorithm, not of any one document. Everything this
 * function DOES detect is masked; the gap is what it cannot recognize as a name in the
 * first place, not something it detects and leaves unmasked.
 *
 * Operational identifiers (student id, course code, employee number) are never touched:
 * masking them would break the analysis the document is being prepared for.
 */

export type DirectIdentifierKind =
  | "email"
  | "phone"
  | "my-number"
  | "passport-number"
  | "bank-account"
  | "credit-card"
  | "known-value";

export interface TextDeidentifyResult {
  text: string;
  /** How many substitutions were made, by kind (registry reuse + shape patterns). */
  replaced: Record<DirectIdentifierKind, number>;
  /** Total substitutions, including `unlinkedNameCount`. */
  replacedTotal: number;
  /**
   * How many CJK name-shaped candidates were masked WITHOUT a same-document linking
   * key (a fresh, unlinked token — see the module doc comment). An AUDIT signal for
   * reporting ("N names masked without cross-format linkage confirmation"), not a
   * safety gate: every candidate this function detects is masked either way, so a
   * non-zero count here does not mean anything was left raw.
   */
  unlinkedNameCount: number;
}

/**
 * Patterns for identifiers whose SHAPE identifies them. Ordered most-specific first so
 * a MyNumber is not consumed by the generic long-digit rule.
 *
 * Deliberately absent: a "6+ digits is an id" rule. That is what previously turned
 * course codes and timestamps into PHONE tokens.
 */
const PATTERNS: readonly { kind: DirectIdentifierKind; re: RegExp; token: string }[] = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, token: "EMAIL" },
  // MyNumber: exactly 12 digits, optionally grouped in 4s.
  { kind: "my-number", re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, token: "GOVID" },
  // Payment card: 13–16 digits in groups of four.
  { kind: "credit-card", re: /\b(?:\d{4}[ -]){3}\d{3,4}\b/g, token: "CARDNO" },
  // Japanese phone shapes: 0X-XXXX-XXXX / 0XX-XXX-XXXX / +81-…
  { kind: "phone", re: /(?:\+81[ -]?|\b0)\d{1,4}[ -]\d{2,4}[ -]\d{3,4}\b/g, token: "PHONE" },
  { kind: "passport-number", re: /\b[A-Z]{2}\d{7}\b/g, token: "PASSPORT" },
];

/** A run of CJK characters that plausibly names a person (2–4 chars). */
const CJK_NAMEISH = /[一-鿿]{2,4}/g;

/**
 * Words that are 2–4 CJK characters but are labels, not names. Without this, a header
 * word like 氏名 or 成績 would be reported as an undetectable name on every document.
 */
const CJK_LABELS = new Set([
  "氏名", "名前", "住所", "電話", "電話番号", "生年月日", "性別", "年齢",
  "成績", "評定", "評点", "点数", "出席", "学籍", "学籍番号", "学生証",
  "科目", "授業", "教員", "担当", "担当教員", "学部", "学科", "学年",
  "合計", "小計", "平均", "備考", "日付", "時刻", "番号", "区分", "種別",
  "所属", "部署", "会社", "大学", "学校", "資格", "点検", "確認", "報告",
  "一覧", "明細", "内容", "金額", "単位", "期間", "年度", "学期", "試験",
]);

function emptyCounts(): Record<DirectIdentifierKind, number> {
  return {
    email: 0,
    phone: 0,
    "my-number": 0,
    "passport-number": 0,
    "bank-account": 0,
    "credit-card": 0,
    "known-value": 0,
  };
}

/**
 * Mask direct personal identifiers in free text.
 *
 * `context` is the RUN registry. Passing the same context that prepared the run's tables
 * is what makes one person carry one token across a CSV, a TXT, an XLSX and a PDF.
 */
export function deidentifyText(
  input: string,
  context: StudentAliasContext = createStudentAliasContext(),
  mode: PrivacyMode = DEFAULT_PRIVACY_MODE,
): TextDeidentifyResult {
  const replaced = emptyCounts();

  // `trusted-local` transforms nothing, by definition.
  if (!modeTransformsDirectIdentifiers(mode)) {
    return { text: input, replaced, replacedTotal: 0, unlinkedNameCount: 0 };
  }

  let text = input;

  // 1. Values LINKED to this run's tabular registry via a strong key present in the
  //    SAME text — reuse the SAME token the table used. Computed once from the
  //    ORIGINAL input (not the in-progress `text`), since linkage is a property of the
  //    whole document, not of what has been replaced so far. Longest value first, so a
  //    full name is replaced before a substring of it.
  const reachableEntities = entitiesReachableInText(context, input);
  const known = [...directPersonalValueTokensForEntities(context, reachableEntities).entries()]
    .filter(([value]) => value.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [normalized, token] of known) {
    // The registry is keyed on the normalized form, so match case-insensitively and
    // compare normalized candidates rather than building a fragile regex per value.
    let index = text.toLowerCase().indexOf(normalized);
    while (index !== -1) {
      const candidate = text.slice(index, index + normalized.length);
      if (normalizeIdentifierValue(candidate) === normalized) {
        text = text.slice(0, index) + token + text.slice(index + normalized.length);
        replaced["known-value"] += 1;
        index = text.toLowerCase().indexOf(normalized, index + token.length);
      } else {
        index = text.toLowerCase().indexOf(normalized, index + 1);
      }
    }
  }

  // 2. Shape-detectable identifiers, with stable per-value tokens.
  const minted = new Map<string, string>();
  for (const { kind, re, token } of PATTERNS) {
    text = text.replace(re, (match) => {
      const key = `${kind}:${normalizeIdentifierValue(match)}`;
      let assigned = minted.get(key);
      if (!assigned) {
        assigned = `${token}-${String(minted.size + 1).padStart(3, "0")}`;
        minted.set(key, assigned);
      }
      replaced[kind] += 1;
      return assigned;
    });
  }

  // 3. CJK name-shaped candidates with no linking key: mask with a FRESH, unlinked
  //    token — masked, never left raw, but deliberately NOT merged onto any existing
  //    entity (a value match alone is not sufficient evidence of identity — see the
  //    module doc comment). Reused consistently within THIS call only: a second
  //    mention of the same string later in this same document gets the same token: a
  //    DIFFERENT document mints its own, independent token for the same string, since
  //    nothing here confirms it is the same person.
  const unlinkedTokens = new Map<string, string>();
  let unlinkedNameCount = 0;
  text = text.replace(CJK_NAMEISH, (word) => {
    if (CJK_LABELS.has(word)) return word;
    const normalized = normalizeIdentifierValue(word);
    let token = unlinkedTokens.get(normalized);
    if (!token) {
      token = mintUnlinkedPersonalToken(context, "name");
      unlinkedTokens.set(normalized, token);
    }
    unlinkedNameCount += 1;
    return token;
  });

  const replacedTotal = Object.values(replaced).reduce((a, b) => a + b, 0) + unlinkedNameCount;
  return { text, replaced, replacedTotal, unlinkedNameCount };
}

/**
 * Verification pass for any DELIVERED artifact — companion markdown, generated summary,
 * handoff document, extracted text.
 *
 * Returns the count of residual DIRECT personal identifiers. Operational identifiers are
 * allowed through by design and are never counted here.
 */
export function scanTextForDirectPersonalIdentifiers(
  text: string,
  knownDirectValues: Iterable<string> = [],
): { residual: number; kinds: DirectIdentifierKind[]; residualRisk: boolean } {
  const kinds = new Set<DirectIdentifierKind>();
  let residual = 0;

  for (const { kind, re } of PATTERNS) {
    // Fresh regex: the module-level ones are global and carry `lastIndex`.
    const matches = text.match(new RegExp(re.source, "g"));
    if (matches && matches.length > 0) {
      residual += matches.length;
      kinds.add(kind);
    }
  }
  for (const value of knownDirectValues) {
    const normalized = normalizeIdentifierValue(value);
    if (normalized.length >= 2 && text.toLowerCase().includes(normalized)) {
      residual += 1;
      kinds.add("known-value");
    }
  }

  const leftover = new Set<string>();
  for (const match of text.matchAll(CJK_NAMEISH)) {
    if (!CJK_LABELS.has(match[0])) leftover.add(match[0]);
  }

  return { residual, kinds: [...kinds], residualRisk: leftover.size > 0 };
}
