import type { FieldSpec } from "./schema";

/**
 * Parse a number written with locale separators, both conventions:
 * - US/UK: comma thousands, dot decimal — `1,234.56`, `1,234`
 * - EU:    dot thousands, comma decimal — `1.234,56`, `12,5`
 *
 * Disambiguation: when both separators are present, the **rightmost** one is the
 * decimal point and the other is the thousands grouping (`1,234.56` → dot decimal;
 * `1.234,56` → comma decimal). When only one separator appears, a trailing group
 * of exactly three digits (`1,234`, `1.234`) reads as thousands; otherwise it's
 * the decimal (`12,5`, `23.33`). Returns null when `v` isn't a plain numeric string.
 */
function parseLocaleNumber(v: string): number | null {
  if (!/^-?[\d.,]+$/.test(v) || !/\d/.test(v)) return null;
  const lastComma = v.lastIndexOf(",");
  const lastDot = v.lastIndexOf(".");
  let normalized: string;
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the rightmost separator is the decimal point.
    const [decimalSep, thousandsSep] = lastComma > lastDot ? [",", "."] : [".", ","];
    normalized = v.split(thousandsSep).join("").replace(decimalSep, ".");
  } else if (lastComma !== -1) {
    // Only commas: groups of exactly three → thousands, else a decimal comma.
    normalized = /^-?\d{1,3}(,\d{3})+$/.test(v) ? v.split(",").join("") : v.replace(",", ".");
  } else if (lastDot !== -1) {
    // Only dots: groups of exactly three → thousands, else a decimal dot.
    normalized = /^-?\d{1,3}(\.\d{3})+$/.test(v) ? v.split(".").join("") : v;
  } else {
    normalized = v;
  }
  const n = Number(normalized);
  return Number.isNaN(n) ? null : n;
}

/**
 * Deterministic value normalization applied before validation:
 * - a range like `20-40` collapses to its midpoint (`30`)
 * - locale numbers (`1.234,50`, `1,234.50`) become a number — see {@link parseLocaleNumber}
 * - bare numeric strings become numbers
 * Otherwise the trimmed string is returned unchanged.
 */
export function normalizeScalar(raw: string): string | number {
  const v = raw.trim();

  const range = /^(-?\d+(?:[.,]\d+)?)\s*[-–]\s*(-?\d+(?:[.,]\d+)?)$/.exec(v);
  if (range) {
    const a = Number(range[1].replace(",", "."));
    const b = Number(range[2].replace(",", "."));
    if (!Number.isNaN(a) && !Number.isNaN(b)) return (a + b) / 2;
  }

  const num = parseLocaleNumber(v);
  if (num !== null) return num;

  // Fallback for numeric forms parseLocaleNumber rejects by design (it only
  // accepts plain `[\d.,-]` strings) — e.g. exponent notation like "1e3".
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One parsed field: its value, and whether it came from a positional/heuristic
 *  pass rather than a `label: value` match (drives `field_source: "positional"`). */
export interface ParsedField {
  value: unknown;
  positional: boolean;
}

// --- positional heuristics ---------------------------------------------------
// Real receipts/invoices rarely print `merchant:` / `total:`; the value is
// positional (header) or whitespace-separated (`TOTAL  23.33`). These fallbacks
// fire ONLY when label:value misses AND the field name is recognized — every
// other field stays null, so the "never guess" contract still holds for things
// we can't place with confidence. Resolved values are tagged
// `field_source: "positional"` so a caller can tell structural placement from a
// read-off-a-label value. Structural array<object> (line_items) is out of scope
// here — that stays for the model rescue pass.
// Canonical field NAMES (exact match, incl. common compound variants) that mean
// "this field IS the merchant / IS the total". Exact-match on purpose: substring
// matching would mis-fire on sub-attributes (`vendor_id`, `shop_address`,
// `total_tax`, `total_items`) and return the wrong value — a guess we must not make.
const MERCHANT_NAMES = new Set([
  "merchant",
  "merchant_name",
  "store",
  "store_name",
  "vendor",
  "vendor_name",
  "seller",
  "seller_name",
  "retailer",
  "shop",
  "shop_name",
  "business",
  "business_name",
  "company",
  "company_name",
]);
const TOTAL_NAMES = new Set([
  "total",
  "grand_total",
  "total_amount",
  "total_due",
  "amount_due",
  "balance_due",
  "montant",
]);

// A grand-total line, but NOT a subtotal (items=subtotal, total=subtotal+tax —
// grabbing the subtotal would silently undercount).
const TOTAL_RE = /\b(grand\s*total|total|montant|amount\s*due|balance\s*due)\b/i;
const SUBTOTAL_RE = /\bsous[-\s]?total\b|\bsub[-\s]?total\b|\bsubtotal\b/i;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b/;
// Global flag is intentional and safe: only ever used with String.prototype.match
// (which is stateless for /g). Do NOT use this with .exec() in a loop — lastIndex.
const NUMBER_RE = /-?\d[\d.,]*\d|\d/g;

/** First "wordy" line — the document header, where a merchant name lives when
 *  the doc never prints `merchant:`. Skips lines that are mostly digits or
 *  punctuation (addresses, phone numbers, amounts). */
function headerMerchant(lines: string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    const digits = (line.match(/\d/gu) ?? []).length;
    if (letters >= 2 && letters >= digits) return line;
  }
  return null;
}

/** The grand-total amount: the last `TOTAL <number>` line that isn't a subtotal.
 *  Last-match-wins because the grand total typically sits below sous-total/tax. */
function findTotal(lines: string[]): number | null {
  let found: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!TOTAL_RE.test(line) || SUBTOTAL_RE.test(line)) continue;
    const nums = line.match(NUMBER_RE);
    if (!nums) continue;
    const n = normalizeScalar(nums[nums.length - 1]);
    if (typeof n === "number") found = n;
  }
  return found;
}

/** First date-shaped token (ISO `2026-05-29` or `d/m/y` style); returned as-is. */
function findDate(lines: string[]): string | null {
  for (const raw of lines) {
    const m = DATE_RE.exec(raw);
    if (m) return m[1];
  }
  return null;
}

/** Structural fallback for a recognized field name; null for anything we can't
 *  place confidently (never guessed). Merchant/total match the canonical name
 *  set exactly; date is token-based (it's legitimately compound — `invoice_date`,
 *  `transaction_date` — while `mandate`/`candidate` carry no `date` token). */
function positionalValue(name: string, lines: string[]): unknown {
  const n = name.toLowerCase();
  if (MERCHANT_NAMES.has(n)) return headerMerchant(lines);
  if (TOTAL_NAMES.has(n)) return findTotal(lines);
  if (n.split(/[^a-z0-9]+/).includes("date")) return findDate(lines);
  return null;
}

/**
 * A real, dependency-free deterministic parser. First tries a `key: value` /
 * `key = value` match per field; if that misses, a positional/heuristic pass
 * places recognized fields (merchant/total/date) from document
 * structure. Powers the passthrough path and stands in for the structural
 * extractors a caller would plug in via an SDK. Fields we can neither
 * label-match nor place structurally come back `null` — never guessed.
 */
export function deterministicParse(text: string, specs: FieldSpec[]): Record<string, ParsedField> {
  const out: Record<string, ParsedField> = {};
  const lines = text.split(/\r?\n/);
  for (const spec of specs) {
    const label = escapeRegExp(spec.name).replace(/_/g, "[ _]");
    const re = new RegExp(`(?:^|\\b)${label}\\s*[:=]\\s*(.+)$`, "i");
    let value: unknown = null;
    for (const line of lines) {
      const m = re.exec(line.trim());
      if (m) {
        value = normalizeScalar(m[1]);
        break;
      }
    }
    let positional = false;
    if (value === null) {
      const pv = positionalValue(spec.name, lines);
      if (pv !== null) {
        value = pv;
        positional = true;
      }
    }
    out[spec.name] = { value, positional };
  }
  return out;
}

/** Why a field tripped the rescue gate (null = clean, no rescue needed). */
export type GateReason =
  | "missing_required"
  | "unparsed"
  | "garbled_glyphs"
  | "out_of_range"
  | "not_in_enum"
  | "low_fuzzy_match"
  | "sparse_row"
  | "low_confidence"
  | "ungrounded";

/** Split text into a set of lowercased word tokens (letters/digits runs). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/**
 * Significant tokens of a value for grounding: lowercased word tokens that
 * contain at least one **letter** and are ≥2 chars. Pure-numeric tokens are
 * deliberately excluded — numbers get reformatted (dates `29/05/2026` →
 * `2026-05-29`, decimals, `$15.00` → `15`), so grounding them by string match
 * would false-flag legitimate transforms. Single letters (`"C"` in `"Super C"`)
 * are skipped as too weak a signal to fabricate.
 */
function significantTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && /\p{L}/u.test(t));
}

/** Levenshtein edit distance between two short strings (two-row DP). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Is a value token *supported* by the source — i.e. does it correspond to a mark
 * actually on the page, possibly garbled? Supported when it matches a source
 * token exactly, OR is a faithful OCR **correction** of one:
 * - **truncation/extension smudge** — one is a ≥3-char prefix of the other and
 *   no more than `PREFIX_MAX_EXTENSION` chars longer (`UNI` ↔ `UNITES`: dropped
 *   trailing glyphs). The length cap stops a short fragment from being laundered
 *   by an unrelated, much longer word that merely shares its prefix
 *   (`uni` ↔ `universities`).
 * - **substitution smudge** — within a small length-scaled edit distance
 *   (`ATL` ↔ `AIL`: a misread glyph).
 *
 * A token with no near-match anywhere is an *addition* with no anchor — a
 * fabrication (`Montreal` appended to an address). The policy is: grounding
 * flags fabrication, never a correction of a real (smudged) mark.
 */
// Max trailing-glyph difference allowed for the prefix (truncation-smudge)
// branch: ≥ "uni"→"unites" (3), small enough that "uni" isn't grounded by a
// 9-char-longer "universities". Independent of `maxDist`, which governs only
// substitutions — a truncation can legitimately exceed the substitution budget.
const PREFIX_MAX_EXTENSION = 3;

function isSupported(token: string, haystack: string[]): boolean {
  // Substitution tolerance: 1 edit for tokens up to 7 chars (a single misread
  // glyph), 2 for longer ones (2 glyphs is still a small fraction of the word).
  // Deliberately tight so unrelated, similar-length words are NOT treated as
  // corrections of each other: `toronto`/`taranto` and `canada`/`banana` are
  // edit-distance 2 at len 6–7 and must stay flagged. Bigger truncations are the
  // prefix branch's job, not this one.
  const maxDist = token.length <= 7 ? 1 : 2;
  for (const h of haystack) {
    if (h === token) return true;
    const [shorter, longer] = h.length < token.length ? [h, token] : [token, h];
    if (
      shorter.length >= 3 &&
      longer.length - shorter.length <= PREFIX_MAX_EXTENSION &&
      longer.startsWith(shorter)
    ) {
      return true;
    }
    if (Math.abs(h.length - token.length) <= maxDist && editDistance(h, token) <= maxDist) {
      return true;
    }
  }
  return false;
}

/**
 * Value grounding (anti-hallucination). For text-bearing engines we
 * have the OCR text to check a model's STRING value against. A significant
 * (alphabetic) token of the value that isn't *supported* by the source —
 * present verbatim or as a near-match correcting a garble (see {@link isSupported})
 * — is unsupported: a likely fabrication (the classic case: a model appends a
 * plausible city to an address). Returns the unsupported tokens (empty =
 * grounded). Non-strings and number-only strings are always grounded here
 * (numeric reconciliation is the self-check's job, not token matching).
 */
export function ungroundedTokens(value: unknown, text: string): string[] {
  if (typeof value !== "string") return [];
  const haystack = [...tokenize(text)];
  return significantTokens(value).filter((t) => !isSupported(t, haystack));
}

/**
 * Whether `value` is a near-miss (typo / OCR garble) of some string `enum`
 * member — within a length-scaled edit distance (~30%, min 1). Powers the
 * low_fuzzy_match gate: `"Mastercrad"` ↔ `"Mastercard"` (dist 1) matches, but an
 * unrelated `"cash"` ↔ `"credit"` does not.
 */
function fuzzyMatchesEnum(value: string, allowed: readonly unknown[]): boolean {
  const v = value.toLowerCase().trim();
  for (const member of allowed) {
    if (typeof member !== "string") continue;
    const m = member.toLowerCase().trim();
    const threshold = Math.max(1, Math.floor(m.length * 0.3));
    if (Math.abs(m.length - v.length) <= threshold && editDistance(v, m) <= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * The rescue gate: decides whether a field is
 * uncertain enough to be worth a paid model call. Composable, schema-derived.
 */
export function gateField(spec: FieldSpec, value: unknown): GateReason | null {
  if (value === null || value === undefined) {
    return spec.required ? "missing_required" : "unparsed";
  }
  const numericField = spec.minimum !== undefined || spec.maximum !== undefined;
  if (typeof value === "string" && numericField && /[^\d.,\-\s]/.test(value)) {
    return "garbled_glyphs";
  }
  if (typeof value === "number") {
    if (spec.minimum !== undefined && value < spec.minimum) return "out_of_range";
    if (spec.maximum !== undefined && value > spec.maximum) return "out_of_range";
  }
  if (spec.enum && !spec.enum.includes(value)) {
    // A value off the allowed set still rescues. Distinguish a near-miss of an
    // allowed value (likely a correctable typo/garble) as low_fuzzy_match from a
    // value with no near match (not_in_enum) — both flag, but the reason guides
    // the fix and is surfaced to the caller.
    return typeof value === "string" && fuzzyMatchesEnum(value, spec.enum)
      ? "low_fuzzy_match"
      : "not_in_enum";
  }
  return null;
}

/**
 * Sparse-row predicate: a structured row (one line-item) that's missing too
 * many of its expected columns is uncertain — flag it for rescue. The row-level
 * sibling of {@link gateField}, kept composable so a caller can tune the
 * threshold. `columns` are the expected keys; `threshold` is the fraction that may
 * be empty before the row counts as sparse (default 0.5 = more than half empty).
 *
 * Empty = null/undefined or a blank string (a column that parsed to nothing).
 *
 * Wiring into actual line-items extraction lands with structured array<object>
 * extraction; the predicate is independent of that pipeline.
 */
export function gateRow(
  row: Record<string, unknown>,
  columns: readonly string[],
  threshold = 0.5,
): GateReason | null {
  if (columns.length === 0) return null;
  const empty = columns.filter((c) => {
    const v = row[c];
    return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  }).length;
  return empty / columns.length > threshold ? "sparse_row" : null;
}
