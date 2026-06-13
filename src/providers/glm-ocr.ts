import type { OcrProvider, OcrResult } from "./types";

/** Z.AI GLM-OCR: $0.03 / 1M tokens, uniform input+output. */
const USD_PER_TOKEN = 0.03 / 1_000_000;

/** One detected layout region in a {@link GlmLayoutParsingResponse}. */
interface GlmLayoutRegion {
  /** Reading-order index. Omitted on the first region in observed responses. */
  index?: number;
  label: "text" | "image" | "formula" | "table";
  /** Content: text, an image URL (label=image), or table HTML (label=table). */
  content: string;
  /** [x1, y1, x2, y2] — cloud API returns ABSOLUTE pixels, not 0–1000. */
  bbox_2d: [number, number, number, number];
}

/** Z.AI GLM-OCR `POST /api/paas/v4/layout_parsing` response. */
interface GlmLayoutParsingResponse {
  /** Full recognized document as one Markdown string (all pages concatenated). */
  md_results?: string;
  /** Detected regions grouped per page → region[], in reading order. */
  layout_details?: GlmLayoutRegion[][];
  data_info?: { num_pages: number; pages: Array<{ width: number; height: number }> };
  /** Token counts for the call (OpenAI-style names). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: Record<string, unknown>;
  };
  id?: string;
  created?: number;
  model?: string;
  request_id?: string;
  /** Region image URLs, only when need_layout_visualization=true. */
  layout_visualization?: string[];
}

/**
 * GLM-OCR via Z.AI's hosted layout-parsing API
 * (`POST /api/paas/v4/layout_parsing`, `model: "glm-ocr"`). A 0.9B multimodal OCR
 * model (MIT) priced at $0.03/1M tokens — markedly cheaper than the Mistral
 * backend. `file` accepts an image or PDF as a URL or base64 data URI (the same
 * `image` shape the scan pipeline already passes); the recognized document comes
 * back as a single markdown string in `md_results`, with token counts in `usage`
 * (reported back so the run can bill/surface OCR cost).
 *
 * The open weights (`zai-org/GLM-OCR`) can also be self-hosted on a serverless GPU
 * and dropped in behind this same `OcrProvider` interface — swap the URL + payload,
 * nothing else changes.
 */
export function glmOcr(apiKey: string): OcrProvider {
  return {
    id: "glm",
    async ocr(image: string): Promise<OcrResult> {
      const res = await fetch("https://api.z.ai/api/paas/v4/layout_parsing", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-ocr",
          file: image,
        }),
      });
      if (!res.ok) {
        // Surface the body — Z.AI returns structured error detail (quota / rate
        // limit), which is what you need while verifying the integration.
        throw new Error(`GLM-OCR failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as GlmLayoutParsingResponse;
      const u = data.usage;
      return {
        text: (data.md_results ?? "").trim(),
        usage: u
          ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 }
          : undefined,
        // Priced on total tokens (input+output billed at the same rate).
        costUsd: u ? (u.total_tokens ?? 0) * USD_PER_TOKEN : undefined,
      };
    },
  };
}
