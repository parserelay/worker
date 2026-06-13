import { afterEach, describe, expect, it, vi } from "vitest";
import { glmOcr } from "./glm-ocr";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("glmOcr", () => {
  it("posts to the Z.AI layout_parsing endpoint and returns trimmed md_results + usage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          md_results: "  Total: 18.50\n",
          usage: { prompt_tokens: 6034, completion_tokens: 615, total_tokens: 6649 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const provider = glmOcr("test-key");
    expect(provider.id).toBe("glm");

    const result = await provider.ocr("data:image/png;base64,AAAA");
    expect(result.text).toBe("Total: 18.50");
    // prompt_tokens → input, completion_tokens → output; cost = total * $0.03/1M.
    expect(result.usage).toEqual({ inputTokens: 6034, outputTokens: 615 });
    expect(result.costUsd).toBeCloseTo((6649 * 0.03) / 1_000_000, 12);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.z.ai/api/paas/v4/layout_parsing");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "glm-ocr",
      file: "data:image/png;base64,AAAA",
    });
  });

  it("returns empty text and no usage when the body is bare", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const result = await glmOcr("k").ocr("https://example.com/doc.pdf");
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  it("throws on a non-2xx response, surfacing the error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limit exceeded", { status: 429 }),
    );
    await expect(glmOcr("k").ocr("data:,")).rejects.toThrow(
      /GLM-OCR failed: 429 rate limit exceeded/,
    );
  });
});
