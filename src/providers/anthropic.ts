import Anthropic from "@anthropic-ai/sdk";
import { buildExtractionShape } from "./format";
import type { ExtractionResult, Provider, StructureInput, Usage, VisionInput } from "./types";

// USD per 1M tokens, verified 2026-05 (output = 5x input across tiers). Priced by
// FAMILY so new point-releases (haiku-4-6, opus-4-9, …) inherit automatically;
// bump here when Anthropic changes rates. Unknown → priciest tier (never undercharge).
const PER_MTOK = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 5, out: 25 },
} as const;

function rateForModel(model: string): { in: number; out: number } {
  const tier = model.includes("opus")
    ? "opus"
    : model.includes("sonnet")
      ? "sonnet"
      : model.includes("haiku")
        ? "haiku"
        : null;
  if (!tier) {
    console.warn(`anthropic: no price for model "${model}"; using priciest (opus) rate`);
  }
  const r = PER_MTOK[tier ?? "opus"];
  return { in: r.in / 1_000_000, out: r.out / 1_000_000 };
}

type ImageSource = Anthropic.Messages.ImageBlockParam["source"];

function imageSource(image: string): ImageSource {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(image);
  if (m) {
    return { type: "base64", media_type: m[1], data: m[2] } as ImageSource;
  }
  return { type: "url", url: image };
}

export function anthropicProvider(model: string, apiKey: string): Provider {
  const client = new Anthropic({ apiKey });
  const price = rateForModel(model);

  // Shared structured-output call; vision and structure differ only in the
  // message content (page image vs OCR text).
  async function extract(
    specs: VisionInput["specs"],
    docType: string,
    content: Anthropic.Messages.MessageParam["content"],
  ): Promise<ExtractionResult> {
    const { schema, systemPrompt } = buildExtractionShape(specs, docType);
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [
        {
          name: "emit_extraction",
          description: "Return the extracted fields and per-field confidences.",
          input_schema: schema as Anthropic.Messages.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "emit_extraction" },
      messages: [{ role: "user", content }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    const out = (block?.type === "tool_use" ? block.input : {}) as {
      fields?: Record<string, unknown>;
      confidence?: Record<string, number>;
      notes?: string[];
    };
    return {
      fields: out.fields ?? {},
      confidence: out.confidence ?? {},
      notes: out.notes ?? [],
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model,
    };
  }

  return {
    id: "anthropic",
    model,
    cost: (u: Usage) => u.inputTokens * price.in + u.outputTokens * price.out,
    vision: ({ image, specs, docType }: VisionInput) =>
      extract(specs, docType, [
        { type: "image", source: imageSource(image) },
        { type: "text", text: "Extract the fields." },
      ]),
    structure: ({ text, specs, docType }: StructureInput) =>
      extract(specs, docType, [
        { type: "text", text: `Document text:\n\n${text}\n\nExtract the fields.` },
      ]),
  };
}
