import OpenAI from "openai";
import { buildExtractionShape } from "./format";
import type { ExtractionResult, Provider, StructureInput, Usage, VisionInput } from "./types";

// USD per 1M tokens, verified 2026-05. Add every model you serve here. An unknown
// model falls back to the priciest known rate (never undercharge) and warns.
const PER_MTOK: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5 },
  "gpt-5.4": { in: 2.5, out: 15 },
  "gpt-5.5": { in: 5, out: 30 },
};

function rateForModel(model: string): { in: number; out: number } {
  const known = PER_MTOK[model];
  if (known) return { in: known.in / 1_000_000, out: known.out / 1_000_000 };
  const max = Object.values(PER_MTOK).reduce((a, b) => (b.in + b.out > a.in + a.out ? b : a));
  console.warn(`openai: no price for model "${model}"; using priciest known rate`);
  return { in: max.in / 1_000_000, out: max.out / 1_000_000 };
}

export function openaiProvider(model: string, apiKey: string): Provider {
  const client = new OpenAI({ apiKey });
  const price = rateForModel(model);

  // Shared structured-output call; vision and structure differ only in the
  // user message content (page image vs OCR text).
  async function extract(
    specs: VisionInput["specs"],
    docType: string,
    content: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"],
  ): Promise<ExtractionResult> {
    const { schema, systemPrompt } = buildExtractionShape(specs, docType);
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema, strict: false },
      },
    });
    const text = res.choices[0]?.message?.content ?? "{}";
    let out: {
      fields?: Record<string, unknown>;
      confidence?: Record<string, number>;
      notes?: string[];
    } = {};
    try {
      out = JSON.parse(text);
    } catch {
      // leave empty; the engine treats missing fields as unresolved
    }
    return {
      fields: out.fields ?? {},
      confidence: out.confidence ?? {},
      notes: out.notes ?? [],
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
      model,
    };
  }

  return {
    id: "openai",
    model,
    cost: (u: Usage) => u.inputTokens * price.in + u.outputTokens * price.out,
    vision: ({ image, specs, docType }: VisionInput) =>
      extract(specs, docType, [
        { type: "text", text: "Extract the fields." },
        { type: "image_url", image_url: { url: image } },
      ]),
    // structure passes a plain string (no image part); vision passes a content array.
    structure: ({ text, specs, docType }: StructureInput) =>
      extract(specs, docType, `Document text:\n\n${text}\n\nExtract the fields.`),
  };
}
