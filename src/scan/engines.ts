import type { Engine as EngineName, FieldSource, SelfCheck } from "@parserelay/core";
import type { ExtractionResult, Provider } from "../providers/types";
import { type GateReason, deterministicParse, gateField, ungroundedTokens } from "./extract";
import type { FieldSpec } from "./schema";

/** Below this self-assessed confidence a model-extracted field is flagged for review. */
const REVIEW_THRESHOLD = 0.6;

/** Confidence is capped to this when a value is re-labelled `inferred` (ungrounded). */
const INFERRED_CONFIDENCE_CAP = 0.5;

export interface EngineInput {
  /** OCR'd text (passthrough), or null when no text layer is available. */
  text: string | null;
  specs: FieldSpec[];
  docType: string;
  /** Dry run: never perform a paid rescue; leave flagged fields uncertain. */
  preview: boolean;
  /** Image URL/data-URI (vision path). */
  image?: string;
  /** Resolved model provider (vision path); null when no key is configured. */
  provider?: Provider | null;
  /** Why the provider couldn't be resolved (for a clean note). */
  providerError?: string;
}

export interface FieldOutcome {
  value: unknown;
  /** 0–1, or null in raw (`ocr`-only) mode where there is no model to judge. */
  confidence: number | null;
  source: FieldSource;
  /** Set when the field tripped the rescue gate. */
  reason: GateReason | null;
}

export interface EngineOutput {
  fields: Record<string, FieldOutcome>;
  rawText: string;
  selfCheck?: SelfCheck;
  model: string | null;
  /** Number of paid rescue calls actually performed. */
  rescueCalls: number;
  /** USD cost of the model call(s), when the engine made one (vision). */
  modelCostUsd?: number;
  /** Raw LLM token usage, when the engine made a model call. */
  usage?: { input: number; output: number };
  note?: string;
}

export interface Engine {
  readonly name: EngineName;
  run(input: EngineInput): Promise<EngineOutput>;
}

const NO_TEXT_NOTE =
  "No text layer available. Wire a real OCR backend, or pass ocr.backend=passthrough with ocr.text.";

/** All fields null — honest output when no extraction could be performed. */
function emptyFields(specs: FieldSpec[], source: FieldSource): Record<string, FieldOutcome> {
  const out: Record<string, FieldOutcome> = {};
  for (const s of specs)
    out[s.name] = { value: null, confidence: null, source, reason: "unparsed" };
  return out;
}

function summarizeSelfCheck(fields: Record<string, FieldOutcome>): SelfCheck {
  const notes: string[] = [];
  for (const [name, f] of Object.entries(fields)) {
    if (f.reason) notes.push(`${name}: ${f.reason}`);
  }
  return { passed: notes.length === 0, notes };
}

/** Map a model's ExtractionResult onto FieldOutcomes: apply the schema gate, and
 *  flag missing / out-of-range / low-confidence values. Shared by `vision` and
 *  `ocr+check` (one reads an image, the other OCR text — the mapping is identical). */
function fieldsFromModel(
  result: ExtractionResult,
  specs: FieldSpec[],
): Record<string, FieldOutcome> {
  const fields: Record<string, FieldOutcome> = {};
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const names = specs.length > 0 ? specs.map((s) => s.name) : Object.keys(result.fields);
  for (const name of names) {
    const spec = specByName.get(name);
    const value = result.fields[name] ?? null;
    const rawConf = result.confidence[name];
    const confidence = typeof rawConf === "number" ? Math.max(0, Math.min(1, rawConf)) : null;
    let reason: GateReason | null = spec ? gateField(spec, value) : null;
    let source: FieldSource;
    if (value === null || value === undefined) {
      source = "uncertain";
      reason = reason ?? (spec?.required ? "missing_required" : "unparsed");
    } else if (reason) {
      source = "uncertain";
    } else if (confidence !== null && confidence < REVIEW_THRESHOLD) {
      source = "uncertain";
      reason = "low_confidence";
    } else {
      source = "model";
    }
    fields[name] = { value, confidence, source, reason };
  }
  return fields;
}

/**
 * Anti-hallucination grounding. For a text-bearing engine, a
 * model STRING value with a significant token that the OCR text doesn't support
 * — not present, and not even a near-match correcting a smudge — is a likely
 * fabrication (an *added* word with no anchor, not a *corrected* one). Re-label
 * it `inferred` (vs `model`) so downstream can tell a guess from extracted data,
 * flag it for review (a `reason` lands it in `needs_review` + the self-check),
 * and cap its confidence. A faithful OCR correction (`ATL`→`AIL`) stays `model`.
 * Never strips the value — marking beats deleting a correct-but-rare one. Only
 * touches `model`-source fields; `deterministic`/`rescued` are grounded by
 * construction, and `vision` has no text layer so it's never run there.
 */
function groundModelFields(fields: Record<string, FieldOutcome>, text: string): void {
  for (const [name, f] of Object.entries(fields)) {
    if (f.source !== "model" || typeof f.value !== "string") continue;
    if (ungroundedTokens(f.value, text).length === 0) continue;
    // A `model`-source field always arrives here with reason === null (see
    // fieldsFromModel), so "ungrounded" is the reason we set, not a fallback.
    fields[name] = {
      ...f,
      source: "inferred",
      reason: "ungrounded",
      confidence: f.confidence === null ? null : Math.min(f.confidence, INFERRED_CONFIDENCE_CAP),
    };
  }
}

// Document-level total field names (first schema-order match wins; best-effort).
const TOTAL_KEYS = ["total", "grand_total", "amount_due", "total_amount", "balance_due"];
// Document-level pre-tax subtotal field names.
const SUBTOTAL_KEYS = ["subtotal", "sub_total", "net", "net_total", "amount_subtotal"];
// Row-level amount field names — here "subtotal"/"total" mean a single row's amount.
const AMOUNT_KEYS = ["amount", "price", "subtotal", "line_total", "total"];
// Tokens marking a top-level field as a tax *amount* (to reconcile items + tax → total).
const TAX_TOKENS = ["tps", "tvq", "gst", "qst", "hst", "pst", "vat", "tax"];
// …but a tax token on a rate / registration-number field is not an amount.
const NON_AMOUNT_TOKENS = ["rate", "percent", "number", "_no", "_id", "registration"];

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // LLMs commonly emit numeric strings like "$15.00" or "1,234.50"; coerce them.
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v.replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First numeric top-level field whose (lowercased) name is in `keys`. */
function firstNumberByKeys(fields: Record<string, FieldOutcome>, keys: string[]): number | null {
  for (const [name, f] of Object.entries(fields)) {
    if (keys.includes(name.toLowerCase())) {
      const n = asFiniteNumber(f.value);
      if (n !== null) return n;
    }
  }
  return null;
}

/** True when a field name denotes a tax *amount* (`tps`, `tvq_amount`, `tax_gst`) rather
 *  than a tax rate or registration number (`tps_rate`, `tvq_number`, `tps_number`). */
function isTaxAmountKey(name: string): boolean {
  const n = name.toLowerCase();
  if (NON_AMOUNT_TOKENS.some((t) => n.includes(t))) return false;
  return TAX_TOKENS.some((t) => n.includes(t));
}

/** Complex-document self-check: do the line items reconcile? Best-effort + tolerant (1%);
 *  returns a note on mismatch, null when not applicable (no item array / no numeric amounts).
 *
 *  Reconciles items against the **subtotal** when one is present (the true "do the items add
 *  up?" check); otherwise against **total minus detected taxes**. This stops a taxed receipt
 *  (items = subtotal, total = subtotal + tax) from false-flagging — the tax gap is not an
 *  extraction error. */
function lineItemsSumNote(fields: Record<string, FieldOutcome>): string | null {
  const rows = Object.values(fields)
    .map((f) => f.value)
    .find(
      (v): v is Record<string, unknown>[] =>
        Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object"),
    );
  if (!rows) return null;

  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    for (const k of AMOUNT_KEYS) {
      const n = asFiniteNumber(row[k]);
      if (n !== null) {
        sum += n;
        counted += 1;
        break;
      }
    }
  }
  if (counted === 0) return null;

  // Prefer reconciling items against an explicit pre-tax subtotal.
  const subtotal = firstNumberByKeys(fields, SUBTOTAL_KEYS);
  if (subtotal !== null) {
    const tol = Math.max(0.01, Math.abs(subtotal) * 0.01);
    if (Math.abs(sum - subtotal) > tol) {
      return `line items sum to ${sum.toFixed(2)} but subtotal is ${subtotal} (off by ${(sum - subtotal).toFixed(2)})`;
    }
    return null;
  }

  // No subtotal: line items + detected taxes should reconcile to the total.
  const total = firstNumberByKeys(fields, TOTAL_KEYS);
  if (total === null) return null;
  let taxSum = 0;
  for (const [name, f] of Object.entries(fields)) {
    if (isTaxAmountKey(name)) {
      const n = asFiniteNumber(f.value);
      if (n !== null) taxSum += n;
    }
  }
  const expected = sum + taxSum;
  const tol = Math.max(0.01, Math.abs(total) * 0.01);
  if (Math.abs(expected - total) > tol) {
    const off = (expected - total).toFixed(2);
    return taxSum
      ? `line items ${sum.toFixed(2)} + tax ${taxSum.toFixed(2)} = ${expected.toFixed(2)} but total is ${total} (off by ${off})`
      : `line items sum to ${sum.toFixed(2)} but total is ${total} (off by ${off})`;
  }
  return null;
}

/** ocr+check self-check: per-field gate reasons + the line-items-vs-total cross-check. */
function checkPass(fields: Record<string, FieldOutcome>): SelfCheck {
  const base = summarizeSelfCheck(fields);
  const sumNote = lineItemsSumNote(fields);
  const notes = sumNote ? [...base.notes, sumNote] : base.notes;
  return { passed: notes.length === 0, notes };
}

/** `ocr` — OCR backend only, no model. Per the contract, confidence is null. */
const ocr: Engine = {
  name: "ocr",
  async run({ text, specs }) {
    if (text === null) {
      return {
        fields: emptyFields(specs, "deterministic"),
        rawText: "",
        model: null,
        rescueCalls: 0,
        note: NO_TEXT_NOTE,
      };
    }
    const parsed = deterministicParse(text, specs);
    const fields: Record<string, FieldOutcome> = {};
    for (const s of specs) {
      const p = parsed[s.name];
      fields[s.name] = {
        value: p.value,
        confidence: null,
        source: p.positional ? "positional" : "deterministic",
        reason: null,
      };
    }
    return {
      fields,
      rawText: text,
      model: null,
      rescueCalls: 0,
      note: "ocr-only: confidence is null by design (raw mode).",
    };
  },
};

/** `ocr+rescue` — deterministic parse of the OCR text, then the LLM rescues ONLY
 *  the flagged fields by reading the page image. Clean fields cost $0. */
const ocrRescue: Engine = {
  name: "ocr+rescue",
  async run({ text, specs, docType, preview, image, provider, providerError }) {
    if (text === null) {
      return {
        fields: emptyFields(specs, "uncertain"),
        rawText: "",
        selfCheck: { passed: false, notes: ["no text layer"] },
        model: null,
        rescueCalls: 0,
        note: providerError ?? NO_TEXT_NOTE,
      };
    }

    const parsed = deterministicParse(text, specs);
    const fields: Record<string, FieldOutcome> = {};
    const flagged: FieldSpec[] = [];
    for (const s of specs) {
      const p = parsed[s.name];
      const reason = gateField(s, p.value);
      if (!reason) {
        // 0.9 is a placeholder "parsed cleanly" score, not a calibrated confidence.
        fields[s.name] = {
          value: p.value,
          confidence: 0.9,
          source: p.positional ? "positional" : "deterministic",
          reason: null,
        };
      } else {
        fields[s.name] = { value: p.value, confidence: null, source: "uncertain", reason };
        flagged.push(s);
      }
    }

    let rescueCalls = 0;
    let modelCostUsd: number | undefined;
    let usage: { input: number; output: number } | undefined;
    let model: string | null = null;
    let note: string | undefined;

    if (flagged.length > 0 && !preview && provider && image) {
      // Rescue reads the actual page image (not the OCR text) for the flagged fields.
      // These come back source="rescued", so the raw_text grounding guard
      // (applied in ocr+check) deliberately does NOT run on them: they are grounded
      // against the image, and the OCR text — by definition too poor to parse them
      // deterministically — is the wrong thing to check a rescued value against.
      const result = await provider.vision({ image, specs: flagged, docType });
      rescueCalls = 1;
      modelCostUsd = provider.cost(result.usage);
      usage = { input: result.usage.inputTokens, output: result.usage.outputTokens };
      model = result.model;
      for (const s of flagged) {
        const value = result.fields[s.name] ?? null;
        const rawConf = result.confidence[s.name];
        const confidence = typeof rawConf === "number" ? Math.max(0, Math.min(1, rawConf)) : null;
        const reason = gateField(s, value);
        if (value !== null && value !== undefined && !reason) {
          fields[s.name] = { value, confidence, source: "rescued", reason: null };
        } else {
          fields[s.name] = {
            value,
            confidence,
            source: "uncertain",
            reason: reason ?? (s.required ? "missing_required" : "unparsed"),
          };
        }
      }
    } else if (flagged.length > 0 && !preview) {
      note = provider
        ? "rescue needs the page image (none provided); flagged fields left for review"
        : "no rescue model configured; flagged fields left for review";
    }

    return {
      fields,
      rawText: text,
      selfCheck: summarizeSelfCheck(fields),
      model,
      rescueCalls,
      modelCostUsd,
      usage,
      note,
    };
  },
};

/** `ocr+check` — the LLM structures EVERY field from the OCR text (not just the
 *  flagged ones, unlike ocr+rescue), then a self-check pass validates cross-field
 *  constraints (line items vs. total). Without a model it degrades to the
 *  deterministic parse + the same self-check. */
const ocrCheck: Engine = {
  name: "ocr+check",
  async run({ text, specs, docType, preview, provider, providerError }) {
    if (text === null) {
      return {
        fields: emptyFields(specs, "uncertain"),
        rawText: "",
        selfCheck: { passed: false, notes: ["no text layer"] },
        model: null,
        rescueCalls: 0,
        note: providerError ?? NO_TEXT_NOTE,
      };
    }

    // Dry run or no model: structure deterministically, still run the self-check.
    if (preview || !provider) {
      const parsed = deterministicParse(text, specs);
      const fields: Record<string, FieldOutcome> = {};
      for (const s of specs) {
        const p = parsed[s.name];
        const reason = gateField(s, p.value);
        fields[s.name] = {
          value: p.value,
          confidence: reason ? 0.4 : 0.7,
          source: reason ? "uncertain" : p.positional ? "positional" : "deterministic",
          reason,
        };
      }
      return {
        fields,
        rawText: text,
        selfCheck: checkPass(fields),
        model: null,
        rescueCalls: 0,
        modelCostUsd: preview ? 0 : undefined,
        note: provider
          ? undefined
          : `ocr+check: no model configured, used the deterministic parse${providerError ? ` (${providerError})` : ""}`,
      };
    }

    // The LLM structures all fields from the OCR text, then we self-check.
    const result = await provider.structure({ text, specs, docType });
    const fields = fieldsFromModel(result, specs);
    // Ground model strings against the OCR text: a value not in the source is
    // re-labelled `inferred` and flagged. checkPass picks up the
    // reason below, so the self-check reports it too.
    groundModelFields(fields, text);
    return {
      fields,
      rawText: text,
      selfCheck: checkPass(fields),
      model: result.model,
      // For ocr+check this counts the structure() model call, not a rescue.
      rescueCalls: 1,
      modelCostUsd: provider.cost(result.usage),
      usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      note: result.notes.length > 0 ? result.notes.join("; ") : undefined,
    };
  },
};

/** `vision` — a vision model reads the image directly and returns structured
 *  fields + per-field confidence. The schema-derived gate still applies (range /
 *  enum), and low self-assessed confidence flags a field for review. */
const vision: Engine = {
  name: "vision",
  async run({ image, specs, docType, preview, provider, providerError }) {
    if (!provider || !image) {
      return {
        fields: emptyFields(specs, "uncertain"),
        rawText: "",
        model: null,
        rescueCalls: 0,
        note: !provider
          ? (providerError ?? "no vision provider configured")
          : "vision requires an image",
      };
    }
    if (preview) {
      // Dry run: don't call the model. Every requested field would be model-extracted.
      const fields: Record<string, FieldOutcome> = {};
      for (const s of specs) {
        fields[s.name] = {
          value: null,
          confidence: null,
          source: "uncertain",
          reason: "low_confidence",
        };
      }
      return { fields, rawText: "", model: provider.model, rescueCalls: 0, modelCostUsd: 0 };
    }

    const result = await provider.vision({ image, specs, docType });
    return {
      fields: fieldsFromModel(result, specs),
      rawText: "",
      model: result.model,
      rescueCalls: 1,
      modelCostUsd: provider.cost(result.usage),
      usage: { input: result.usage.inputTokens, output: result.usage.outputTokens },
      note: result.notes.length > 0 ? result.notes.join("; ") : undefined,
    };
  },
};

const ENGINES: Record<Exclude<EngineName, "auto">, Engine> = {
  ocr,
  "ocr+rescue": ocrRescue,
  "ocr+check": ocrCheck,
  vision,
};

/** Resolve `auto`: a usable text layer -> ocr+rescue, else vision. */
export function resolveEngineName(
  requested: EngineName | undefined,
  hasText: boolean,
): Exclude<EngineName, "auto"> {
  const e = requested ?? "auto";
  if (e === "auto") return hasText ? "ocr+rescue" : "vision";
  return e;
}

export function getEngine(name: Exclude<EngineName, "auto">): Engine {
  return ENGINES[name];
}
