import { describe, expect, it } from "vitest";
import { DEFAULT_VISION_MODEL, providerForModel, resolveOcr } from "./index";

describe("providerForModel", () => {
  it("routes OpenAI model families to openai", () => {
    for (const m of [
      "gpt-4o",
      "gpt-4.1-mini",
      "o1",
      "o3-mini",
      "chatgpt-4o-latest",
      "text-embedding-3",
    ]) {
      expect(providerForModel(m)).toBe("openai");
    }
  });

  it("routes everything else (incl. the default) to anthropic", () => {
    for (const m of [
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-3-5-sonnet",
      DEFAULT_VISION_MODEL,
    ]) {
      expect(providerForModel(m)).toBe("anthropic");
    }
  });

  it("the default vision model is an Anthropic model (so an Anthropic BYO key aligns by default)", () => {
    expect(providerForModel(DEFAULT_VISION_MODEL)).toBe("anthropic");
  });
});

describe("resolveOcr", () => {
  it("passthrough resolves to no backend (caller supplies text)", async () => {
    const r = await resolveOcr("passthrough", {});
    expect(r.ocr).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it("auto prefers GLM-OCR when its key is set", async () => {
    const r = await resolveOcr("auto", { GLM_OCR_API_KEY: "k" });
    expect(r.ocr?.id).toBe("glm");
  });

  it("falls back to Mistral when only the Mistral key is set", async () => {
    const r = await resolveOcr("auto", { MISTRAL_API_KEY: "k" });
    expect(r.ocr?.id).toBe("mistral");
  });

  it("backend=glm selects GLM when its key is set", async () => {
    const r = await resolveOcr("glm", { GLM_OCR_API_KEY: "g", MISTRAL_API_KEY: "m" });
    expect(r.ocr?.id).toBe("glm");
  });

  it("backend=glm errors (no silent Mistral fallback) when only the Mistral key is set", async () => {
    const r = await resolveOcr("glm", { MISTRAL_API_KEY: "m" });
    expect(r.ocr).toBeNull();
    expect(r.error).toMatch(/GLM_OCR_API_KEY/);
  });

  it("backend=mistral selects Mistral even when a GLM key is present", async () => {
    const r = await resolveOcr("mistral", { GLM_OCR_API_KEY: "g", MISTRAL_API_KEY: "m" });
    expect(r.ocr?.id).toBe("mistral");
  });

  it("backend=mistral errors (no silent GLM fallback) when only the GLM key is set", async () => {
    const r = await resolveOcr("mistral", { GLM_OCR_API_KEY: "g" });
    expect(r.ocr).toBeNull();
    expect(r.error).toMatch(/MISTRAL_API_KEY/);
  });

  it("auto errors listing both keys when none is configured", async () => {
    const r = await resolveOcr("auto", {});
    expect(r.ocr).toBeNull();
    expect(r.error).toMatch(/GLM_OCR_API_KEY or MISTRAL_API_KEY/);
  });
});
