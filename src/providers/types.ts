import type { FieldSpec } from "../scan/schema";

/** Token usage from a provider call, used to compute cost. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Normalized result of a model extraction, independent of provider. */
export interface ExtractionResult {
  /** Field name → extracted value (null when the model couldn't find it). */
  fields: Record<string, unknown>;
  /** Field name → self-assessed confidence 0–1 (may omit fields). */
  confidence: Record<string, number>;
  /** Optional free-text model notes (e.g. cross-field observations). */
  notes: string[];
  usage: Usage;
  /** The concrete model id used. */
  model: string;
}

export interface VisionInput {
  /** Image URL or base64 data URI. */
  image: string;
  specs: FieldSpec[];
  docType: string;
}

export interface StructureInput {
  /** OCR'd document text (the `ocr+check` path structures from text, not image). */
  text: string;
  specs: FieldSpec[];
  docType: string;
}

/** Result of an OCR backend call. */
export interface OcrResult {
  text: string;
  /** Tokens the backend reported (e.g. GLM-OCR). Omitted when it reports none (e.g. Mistral free tier). */
  usage?: Usage;
  /** Provider sticker cost in USD for this OCR call. Omitted/0 when free. */
  costUsd?: number;
}

/** An OCR backend: image/PDF in, text (+ optional usage/cost) out. */
export interface OcrProvider {
  readonly id: string;
  ocr(image: string): Promise<OcrResult>;
}

/** A model provider bound to a specific model + API key. */
export interface Provider {
  /** Provider id, e.g. "anthropic" | "openai". */
  readonly id: string;
  /** The model id this instance uses (echoed into meta.model). */
  readonly model: string;
  /** Extract structured fields from an image (the vision path). */
  vision(input: VisionInput): Promise<ExtractionResult>;
  /** Structure fields from OCR text (the `ocr+check` path). */
  structure(input: StructureInput): Promise<ExtractionResult>;
  /** USD cost for the given token usage on this model. */
  cost(usage: Usage): number;
}
