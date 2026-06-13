import type { OcrProvider } from "./types";

function isPdf(image: string): boolean {
  return image.startsWith("data:application/pdf") || /\.pdf($|\?)/i.test(image);
}

/**
 * Mistral OCR (`POST /v1/ocr`, `mistral-ocr-latest`). Free tier is ~1 req/s,
 * which is plenty for now; cost is treated as $0. Accepts an image or PDF, as a
 * URL or base64 data URI, and returns the concatenated page markdown.
 */
export function mistralOcr(apiKey: string): OcrProvider {
  return {
    id: "mistral",
    async ocr(image: string): Promise<{ text: string }> {
      const document = isPdf(image)
        ? { type: "document_url", document_url: image }
        : { type: "image_url", image_url: image };
      const res = await fetch("https://api.mistral.ai/v1/ocr", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "mistral-ocr-latest",
          document,
          include_image_base64: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`Mistral OCR failed: ${res.status}`);
      }
      const data = (await res.json()) as { pages?: Array<{ markdown?: string }> };
      const text = (data.pages ?? [])
        .map((p) => p.markdown ?? "")
        .join("\n\n")
        .trim();
      return { text };
    },
  };
}
