import type { Bindings } from "../env";
import { glmOcr } from "./glm-ocr";
import { mistralOcr } from "./mistral";
import type { OcrProvider, Provider } from "./types";

export type { Provider, VisionInput, ExtractionResult, Usage, OcrProvider } from "./types";

/** Default model for the vision path / the LLM rescue pass when none is pinned. */
export const DEFAULT_VISION_MODEL = "claude-haiku-4-5";

export interface ResolveOcrResult {
  ocr: OcrProvider | null;
  error?: string;
}

/**
 * Resolve an OCR backend. `passthrough` means the caller already supplied text
 * (no OCR needed → null, no error). An EXPLICIT `glm` / `mistral` resolves only
 * that provider, erroring if its key is absent — a caller who names a backend
 * gets it or a clear error, never a silent substitution. `auto` (and any
 * generic/unknown backend) prefers GLM-OCR and falls back to Mistral, so a
 * deployment with only one key still works. tesseract / paddle slot in the same way.
 */
export async function resolveOcr(backend: string, env: Bindings): Promise<ResolveOcrResult> {
  if (backend === "passthrough") return { ocr: null };
  if (backend === "glm") {
    if (env.GLM_OCR_API_KEY) return { ocr: glmOcr(env.GLM_OCR_API_KEY) };
    return { ocr: null, error: "no OCR backend configured (set GLM_OCR_API_KEY)" };
  }
  if (backend === "mistral") {
    if (env.MISTRAL_API_KEY) return { ocr: mistralOcr(env.MISTRAL_API_KEY) };
    return { ocr: null, error: "no OCR backend configured (set MISTRAL_API_KEY)" };
  }
  // `auto` and generic/unknown backends prefer GLM-OCR, falling back to Mistral.
  if (env.GLM_OCR_API_KEY) return { ocr: glmOcr(env.GLM_OCR_API_KEY) };
  if (env.MISTRAL_API_KEY) return { ocr: mistralOcr(env.MISTRAL_API_KEY) };
  return { ocr: null, error: "no OCR backend configured (set GLM_OCR_API_KEY or MISTRAL_API_KEY)" };
}

/** Which LLM provider a model name routes to (the rest default to Anthropic).
 *  Also used to align a BYO provider key with the model before using it. */
export function providerForModel(model: string): "anthropic" | "openai" {
  // `o\d+` matches the o-series by any number of digits (o1, o3, o10, …).
  return /^(gpt|o\d+|chatgpt|text-|dall)/i.test(model) ? "openai" : "anthropic";
}

export interface ResolveResult {
  provider: Provider | null;
  /** Set when no provider could be resolved (missing key). */
  error?: string;
}

/**
 * Resolve a {@link Provider} for `model`, using the caller's BYO `modelKey` when
 * present, else the server key from env. SDK adapters are dynamic-imported so the
 * heavy SDKs only load when a real provider is actually needed — never in tests,
 * which inject a fake resolver.
 */
export async function resolveProvider(
  model: string,
  modelKey: string | null,
  env: Bindings,
): Promise<ResolveResult> {
  if (providerForModel(model) === "openai") {
    const key = modelKey ?? env.OPENAI_API_KEY;
    if (!key) return { provider: null, error: "no OpenAI API key configured" };
    const { openaiProvider } = await import("./openai");
    return { provider: openaiProvider(model, key) };
  }
  const key = modelKey ?? env.ANTHROPIC_API_KEY;
  if (!key) return { provider: null, error: "no Anthropic API key configured" };
  const { anthropicProvider } = await import("./anthropic");
  return { provider: anthropicProvider(model, key) };
}
