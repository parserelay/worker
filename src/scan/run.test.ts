import type { ScanRequest } from "@parserelay/core";
import { describe, expect, it } from "vitest";
import type { ExtractionResult } from "../providers/types";
import { type ResolveOcrFn, type ResolveProviderFn, runScan } from "./run";

/** A fake OCR resolver returning fixed text. */
function fakeOcr(text: string): ResolveOcrFn {
  return async () => ({ ocr: { id: "fake-ocr", ocr: async () => ({ text }) } });
}

/** A fake OCR resolver that also reports token usage + a USD cost (like GLM-OCR). */
function fakeOcrWithCost(text: string, costUsd: number): ResolveOcrFn {
  return async () => ({
    ocr: {
      id: "fake-ocr",
      ocr: async () => ({ text, usage: { inputTokens: 6034, outputTokens: 615 }, costUsd }),
    },
  });
}

/** A fake provider resolver so vision tests never hit the network. */
function fakeResolver(result: Partial<ExtractionResult>, costUsd = 0.005): ResolveProviderFn {
  return async (model) => {
    const extraction = async (): Promise<ExtractionResult> => ({
      fields: {},
      confidence: {},
      notes: [],
      usage: { inputTokens: 1000, outputTokens: 50 },
      model,
      ...result,
    });
    return {
      provider: {
        id: "fake",
        model,
        cost: () => costUsd,
        vision: extraction,
        structure: extraction,
      },
    };
  };
}

describe("runScan", () => {
  it("ocr-only mode returns confidence: null per field (raw mode)", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr",
      schema: ["merchant"],
      ocr: { backend: "passthrough", text: "Merchant: Acme" },
    };
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr");
    expect(r.fields.merchant).toBe("Acme");
    expect(r.confidence.merchant).toBeNull();
  });

  it("multi-page: merges fields across pages and bills one credit per page", async () => {
    // Per-page OCR: page 1 carries the merchant, page 2 the total.
    const ocrByPage: ResolveOcrFn = async () => ({
      ocr: {
        id: "fake-ocr",
        ocr: async (image: string) => ({
          text: image.includes("page2") ? "Total: 99.50" : "Merchant: Acme",
        }),
      },
    });
    const req: ScanRequest = {
      image: "data:page1",
      pages: ["data:page2"],
      schema: ["merchant", "total"],
      engine: "ocr+rescue",
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: ocrByPage,
      resolveProvider: fakeResolver({}), // rescue finds nothing → unresolved stays null
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.fields.merchant).toBe("Acme"); // best value came from page 1
    expect(r.fields.total).toBe(99.5); // …and from page 2
    expect(r.meta.scan_credits).toBe(2); // one plumbing credit per page
    expect(r.raw_text).toContain("Merchant: Acme");
    expect(r.raw_text).toContain("Total: 99.50");
  });

  it("multi-page dry-run: plumbing scales with page count", async () => {
    const req: ScanRequest = {
      image: "data:p1",
      pages: ["data:p2", "data:p3"],
      schema: ["merchant"],
      engine: "ocr",
      ocr: { backend: "passthrough", text: "no labels here" },
      dry_run: true,
    };
    const r = await runScan(req, { preview: true, env: {} });
    if (r.status !== "dry_run") throw new Error("expected dry_run");
    expect(r.scan_credits).toBe(3); // three pages
  });

  it("BYO deterministic scan: plumbing only, no model usage", async () => {
    const req: ScanRequest = {
      image: "data:,",
      model_key: "sk-byo",
      schema: ["merchant"],
      ocr: { backend: "passthrough", text: "Merchant: Acme" },
    };
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.tokens).toBeUndefined(); // deterministic — no model ran
    expect(r.meta.scan_credits).toBe(1);
    expect(r.meta.total_credits).toBe(1); // plumbing only
  });

  it("auto resolves to vision when there is no text layer", async () => {
    const req: ScanRequest = { image: "https://example.test/photo.jpg", schema: ["merchant"] };
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("vision");
    expect(r.meta.ocr_backend).toBeNull();
  });

  it("vision extracts via the model: field_source=model, confidence, cost", async () => {
    const resolveProvider = fakeResolver({
      fields: { merchant: "Blue Bottle", total: 18.5 },
      confidence: { merchant: 0.95, total: 0.92 },
    });
    const req: ScanRequest = {
      image: "data:image/png;base64,AAA",
      doc_type: "receipt",
      schema: ["merchant", "total"],
    };
    const r = await runScan(req, { preview: false, env: {}, resolveProvider });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.status).toBe("ok");
    expect(r.meta.engine).toBe("vision");
    expect(r.meta.model).toBe("claude-haiku-4-5");
    expect(r.fields).toEqual({ merchant: "Blue Bottle", total: 18.5 });
    expect(r.field_source?.merchant).toBe("model");
    expect(r.confidence.total).toBeCloseTo(0.92);
    expect(r.needs_review).toEqual([]);
    expect(r.meta.tokens?.input).toBe(1000);
    expect(r.meta.tokens?.output).toBe(50);
    // $0.005 sticker × 1.15 ÷ $0.002 = 2.875 credits (fractional)
    expect(r.meta.tokens?.credits).toBeCloseTo(2.875);
    expect(r.meta.scan_credits).toBe(1);
    expect(r.meta.total_credits).toBeCloseTo(3.875);
  });

  it("vision flags low-confidence fields for review", async () => {
    const resolveProvider = fakeResolver({
      fields: { merchant: "Blurry?" },
      confidence: { merchant: 0.3 },
    });
    const req: ScanRequest = { image: "data:,", schema: ["merchant"] };
    const r = await runScan(req, { preview: false, env: {}, resolveProvider });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.status).toBe("partial");
    expect(r.needs_review).toContain("merchant");
    expect(r.field_source?.merchant).toBe("uncertain");
    expect(r.meta.scan_credits).toBe(1); // partial still consumes a credit
  });

  it("vision honours a BYO model_key: model cost on your key, not credits", async () => {
    let sawKey: string | null = null;
    const resolveProvider: ResolveProviderFn = async (model, modelKey) => {
      sawKey = modelKey;
      return await fakeResolver({ fields: { merchant: "Acme" }, confidence: { merchant: 0.9 } })(
        model,
        modelKey,
        {},
      );
    };
    const req: ScanRequest = { image: "data:,", model_key: "sk-caller", schema: ["merchant"] };
    const r = await runScan(req, { preview: false, env: {}, resolveProvider });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(sawKey).toBe("sk-caller");
    expect(r.meta.tokens?.provider_cost_usd).toBeCloseTo(0.005); // sticker, on your key
    expect(r.meta.tokens?.credits).toBeUndefined(); // never billed as credits
    expect(r.meta.total_credits).toBe(1); // plumbing only
  });

  it("vision with no configured provider key returns a failed envelope", async () => {
    const req: ScanRequest = { image: "data:,", schema: ["merchant"] };
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("vision");
    expect(r.status).toBe("failed");
    expect(r.meta.note ?? "").toMatch(/api key/i);
    expect(r.meta.scan_credits).toBe(0);
  });

  it("ocr+rescue parses OCR text deterministically; no rescue when clean", async () => {
    const req: ScanRequest = {
      image: "data:image/png;base64,AAA",
      engine: "ocr+rescue",
      schema: ["merchant", "total"],
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcr("Merchant: Acme\nTotal: 18.50"),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr+rescue");
    expect(r.fields).toEqual({ merchant: "Acme", total: 18.5 });
    expect(r.field_source?.merchant).toBe("deterministic");
    expect(r.meta.tokens).toBeUndefined(); // clean parse, no model ran
    expect(r.meta.total_credits).toBe(1); // plumbing only
    expect(r.status).toBe("ok");
  });

  it("bills OCR-backend usage as credits (our key) and folds it into total_credits", async () => {
    const req: ScanRequest = {
      image: "data:image/png;base64,AAA",
      engine: "ocr+rescue",
      schema: ["merchant", "total"],
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcrWithCost("Merchant: Acme\nTotal: 18.50", 0.0002),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.ocr_usage?.input).toBe(6034);
    expect(r.meta.ocr_usage?.output).toBe(615);
    // (0.0002 * 1.15) / 0.002 = 0.115 credits, folded into total alongside plumbing.
    const ocrCredits = r.meta.ocr_usage?.credits ?? 0;
    expect(ocrCredits).toBeCloseTo(0.115, 6);
    expect(r.meta.total_credits).toBeCloseTo(1 + ocrCredits, 6);
  });

  it("bills OCR credits even with a BYO model_key (OCR is on our key; the model is on yours)", async () => {
    // The user's case: an Anthropic BYO key. The model bills to that key
    // (provider_cost_usd), but the OCR backend ran on OUR z.ai key → credits.
    const req: ScanRequest = {
      image: "data:image/png;base64,AAA",
      engine: "ocr+check",
      schema: ["merchant", "total"],
      model_key: "sk-byo",
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcrWithCost("Merchant: Acme\nTotal: 18.50", 0.0002),
      resolveProvider: fakeResolver(
        { fields: { merchant: "Acme", total: 18.5 }, confidence: { merchant: 0.9, total: 0.9 } },
        0.0042,
      ),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    // Model → on your key, in dollars, never credits.
    expect(r.meta.tokens?.provider_cost_usd).toBeCloseTo(0.0042);
    expect(r.meta.tokens?.credits).toBeUndefined();
    // OCR → on our key, billed as credits regardless of the model BYO.
    const ocrCredits = r.meta.ocr_usage?.credits ?? 0;
    expect(ocrCredits).toBeCloseTo(0.115, 6);
    expect(r.meta.total_credits).toBeCloseTo(1 + ocrCredits, 6); // plumbing + OCR (NOT the model $)
  });

  it("ocr+rescue rescues a flagged (out-of-range) field from the image", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+rescue",
      schema: {
        type: "object",
        properties: { age: { minimum: 0, maximum: 120 } },
        required: ["age"],
      },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcr("age: 999"),
      resolveProvider: fakeResolver({ fields: { age: 42 }, confidence: { age: 0.95 } }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.fields.age).toBe(42);
    expect(r.field_source?.age).toBe("rescued");
    expect(r.meta.tokens?.credits).toBeCloseTo(2.875); // one rescue, fractional credits
    expect(r.meta.tokens?.input).toBe(1000);
    expect(r.meta.total_credits).toBeCloseTo(3.875);
    expect(r.status).toBe("ok");
  });

  it("BYO dry run: estimated_model_credits absent even when fields would rescue", async () => {
    const req: ScanRequest = {
      image: "data:,",
      dry_run: true,
      model_key: "sk-caller",
      schema: {
        type: "object",
        properties: { age: { minimum: 0, maximum: 120 } },
        required: ["age"],
      },
    };
    const r = await runScan(req, { preview: true, env: {}, resolveOcr: fakeOcr("age: 999") });
    expect(r.status).toBe("dry_run");
    if (r.status !== "dry_run") return;
    expect(r.would_rescue.length).toBeGreaterThan(0); // the rescue gate did fire
    expect(r.scan_credits).toBe(1);
    expect(r.estimated_model_credits).toBeUndefined(); // BYO → model runs on caller's key
  });

  it("ocr+check structures every field via the model and self-checks", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["merchant", "total"],
      ocr: { backend: "passthrough", text: "Acme\nTotal: 18.50" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { merchant: "Acme", total: 18.5 },
        confidence: { merchant: 0.95, total: 0.92 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr+check");
    expect(r.field_source?.merchant).toBe("model");
    expect(r.fields).toEqual({ merchant: "Acme", total: 18.5 });
    expect(r.self_check?.passed).toBe(true);
    expect(r.meta.tokens?.credits).toBeCloseTo(2.875);
    expect(r.meta.tokens?.input).toBe(1000);
    expect(r.meta.total_credits).toBeCloseTo(3.875);
  });

  it("ocr+check flags an ungrounded model string as inferred (anti-hallucination)", async () => {
    // The Super C case: the receipt prints only "147 AVENUE ATWATER"; the model
    // appended a plausible city ("Montreal") that is nowhere in the source text.
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["location", "total"],
      ocr: { backend: "passthrough", text: "147 AVENUE ATWATER\nTotal: 23.33" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { location: "147, Avenue Atwater, Montreal", total: 23.33 },
        confidence: { location: 0.9, total: 0.95 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.field_source?.location).toBe("inferred");
    expect(r.field_source?.total).toBe("model"); // numeric, grounded by construction
    expect(r.needs_review).toContain("location");
    expect(r.fields.location).toBe("147, Avenue Atwater, Montreal"); // marked, never stripped
    expect(r.confidence.location ?? 1).toBeLessThanOrEqual(0.5); // capped
    expect(r.self_check?.passed).toBe(false);
    expect(r.self_check?.notes.some((n) => n.includes("location"))).toBe(true);
    expect(r.status).toBe("partial");
  });

  it("grounding does not false-flag case, date, or numeric reformatting", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["merchant", "date", "total"],
      ocr: { backend: "passthrough", text: "super c market\nDate 29/05/2026\nTotal 15" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: {
          merchant: "Super C", // case-normalized — "super" is in the text
          date: "2026-05-29", // reformatted date — all-numeric tokens, never flagged
          total: 15,
        },
        confidence: { merchant: 0.95, date: 0.95, total: 0.95 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.field_source?.merchant).toBe("model");
    expect(r.field_source?.date).toBe("model");
    expect(r.needs_review).toEqual([]);
    expect(r.self_check?.passed).toBe(true);
  });

  it("does NOT flag a faithful OCR correction as inferred (policy: fix ≠ fabrication)", async () => {
    // Super C receipt: smudged ink turned the printed "AIL 3 UNITES" into the
    // garbled OCR line "ATL 3 UNI S". The model corrects the misread to the real
    // words. Each corrected token is a near-match of the garble actually on the
    // page (ATL→AIL is one edit; UNI→UNITES is a truncation), so the value is
    // grounded — grounding flags fabrication, not a faithful correction.
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["item", "unit"],
      ocr: { backend: "passthrough", text: "ATL 3 UNI S\nTotal 23.33" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { item: "AIL", unit: "UNITES" },
        confidence: { item: 0.9, unit: 0.9 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.field_source?.item).toBe("model"); // ATL→AIL: 1-edit substitution smudge
    expect(r.field_source?.unit).toBe("model"); // UNI→UNITES: truncation smudge (prefix)
    expect(r.needs_review).toEqual([]);
    expect(r.self_check?.passed).toBe(true);
  });

  it("still flags a fabricated token even when the field also contains a valid correction", async () => {
    // "AIL" is a legit correction of the garbled "ATL"; "biologique" is nowhere on
    // the page. One unsupported token is enough to flag the whole field — a real
    // correction sitting next to a fabrication does not launder it.
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["item"],
      ocr: { backend: "passthrough", text: "ATL 3 UNI S" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { item: "AIL biologique" },
        confidence: { item: 0.9 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.field_source?.item).toBe("inferred"); // "biologique" has no anchor in the text
    expect(r.needs_review).toContain("item");
    expect(r.self_check?.passed).toBe(false); // the ungrounded reason fails the check too
  });

  it("self-check passes when line items reconcile to the subtotal (tax is not a mismatch)", async () => {
    // The Super C case: items sum to the subtotal; total = subtotal + TPS + TVQ.
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["items", "subtotal", "tps", "tvq", "total"],
      ocr: { backend: "passthrough", text: "receipt" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: {
          items: [
            { name: "MVICK", price: 6.49 },
            { name: "DAIRYM", price: 1.25 },
            { name: "POIRES", price: 1.45 },
            { name: "PATATE", price: 2.28 },
            { name: "ATL", price: 0.99 },
            { name: "POIREAUX", price: 5.99 },
            { name: "BANANE", price: 3.72 },
          ],
          subtotal: 22.17,
          tps: 0.39,
          tvq: 0.77,
          total: 23.33,
        },
        confidence: { items: 0.9, subtotal: 0.95, tps: 0.95, tvq: 0.95, total: 0.95 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    // items sum 22.17 === subtotal → no false "off by -1.16" alarm.
    expect(r.self_check?.passed).toBe(true);
    expect(r.self_check?.notes ?? []).toHaveLength(0);
  });

  it("self-check reconciles items + tax against total when there is no subtotal", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["items", "tax_gst", "tax_qst", "total"],
      ocr: { backend: "passthrough", text: "receipt" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: {
          items: [{ price: 10 }, { price: 12.17 }],
          tax_gst: 0.39,
          tax_qst: 0.77,
          total: 23.33,
        },
        confidence: { items: 0.9, tax_gst: 0.95, tax_qst: 0.95, total: 0.95 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.self_check?.passed).toBe(true); // 22.17 items + 1.16 tax = 23.33
  });

  it("self-check still flags a genuine line-item mismatch", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["items", "total"],
      ocr: { backend: "passthrough", text: "receipt" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { items: [{ price: 10 }, { price: 10 }], total: 50 },
        confidence: { items: 0.9, total: 0.95 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    // No subtotal, no tax: items (20) ≠ total (50) → real mismatch is still reported.
    expect(r.self_check?.passed).toBe(false);
    expect(r.self_check?.notes.join(" ")).toContain("but total is 50");
  });

  it("ocr+check self-check flags line items that don't sum to the total", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: {
        type: "object",
        properties: { total: { type: "number" }, line_items: { type: "array" } },
      },
      ocr: { backend: "passthrough", text: "irrelevant" },
    };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({
        fields: { total: 100, line_items: [{ amount: 10 }, { amount: 20 }] },
        confidence: { total: 0.95, line_items: 0.9 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.self_check?.passed).toBe(false);
    expect(r.self_check?.notes.some((n) => n.includes("line items sum"))).toBe(true);
  });

  it("ocr+check degrades to the deterministic parse (+ self-check, note) with no model", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr+check",
      schema: ["merchant", "total"],
      ocr: { backend: "passthrough", text: "Merchant: Acme\nTotal: 18.50" },
    };
    // No resolveProvider and no provider key in env → provider resolves to null.
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr+check");
    expect(r.meta.model).toBeNull();
    expect(r.meta.note ?? "").toMatch(/no model/i);
    expect(r.self_check).toBeDefined();
    expect(r.meta.tokens).toBeUndefined(); // no model ran
    expect(r.meta.total_credits).toBe(1); // plumbing only
  });

  it("ocr resolves merchant + total positionally on an unlabeled receipt", async () => {
    const req: ScanRequest = {
      image: "data:,",
      engine: "ocr",
      schema: ["merchant", "total"],
      ocr: {
        backend: "passthrough",
        text: "SUPER C\n147 AVENUE ATWATER\nSOUS-TOTAL 22.17\nTPS 0.39\nTVQ 0.77\nTOTAL 23.33",
      },
    };
    const r = await runScan(req, { preview: false, env: {} });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.fields.merchant).toBe("SUPER C"); // header line, no `merchant:` label
    expect(r.fields.total).toBe(23.33); // TOTAL line, not the 22.17 SOUS-TOTAL
    expect(r.field_source?.merchant).toBe("positional");
    expect(r.field_source?.total).toBe("positional");
    expect(r.status).toBe("ok");
  });

  it("ocr+rescue resolves positionally and skips the paid rescue (cost win)", async () => {
    const req: ScanRequest = {
      image: "data:image/png;base64,AAA",
      engine: "ocr+rescue",
      schema: ["merchant", "total"],
      ocr: { backend: "passthrough", text: "SUPER C\nSOUS-TOTAL 22.17\nTOTAL 23.33" },
    };
    // A provider + image ARE available; a clean positional parse must still mean
    // NO rescue call — this is the economics it restores (vs degenerating to vision).
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveProvider: fakeResolver({ fields: { merchant: "WRONG", total: 0 }, confidence: {} }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.fields.merchant).toBe("SUPER C"); // from OCR text, the model never ran
    expect(r.fields.total).toBe(23.33);
    expect(r.field_source?.merchant).toBe("positional");
    expect(r.meta.tokens).toBeUndefined(); // no rescue performed
    expect(r.meta.total_credits).toBe(1); // plumbing only — the cost win
    expect(r.status).toBe("ok");
  });

  it("auto prefers ocr+rescue when OCR yields text (OCR-first)", async () => {
    const req: ScanRequest = { image: "data:,", schema: ["merchant"] };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcr("Merchant: Acme"),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr+rescue");
    expect(r.fields.merchant).toBe("Acme");
  });

  it("ocr+rescue surfaces the OCR error (not the LLM-key error) when OCR fails", async () => {
    const resolveOcr: ResolveOcrFn = async () => ({
      ocr: null,
      error: "no OCR backend configured",
    });
    const req: ScanRequest = { image: "data:,", engine: "ocr+rescue", schema: ["merchant"] };
    // No resolveProvider + empty env → LLM key also missing; the OCR error must win.
    const r = await runScan(req, { preview: false, env: {}, resolveOcr });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("ocr+rescue");
    expect(r.status).toBe("failed");
    expect(r.meta.note ?? "").toMatch(/ocr backend/i);
  });

  it("reports the OCR provider id in meta.ocr_backend", async () => {
    const req: ScanRequest = { image: "data:,", engine: "ocr+rescue", schema: ["merchant"] };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcr("Merchant: Acme"),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.ocr_backend).toBe("fake-ocr");
  });

  it("auto falls back to vision when OCR yields no text", async () => {
    const req: ScanRequest = { image: "data:,", schema: ["merchant"] };
    const r = await runScan(req, {
      preview: false,
      env: {},
      resolveOcr: fakeOcr(""),
      resolveProvider: fakeResolver({
        fields: { merchant: "Acme" },
        confidence: { merchant: 0.9 },
      }),
    });
    if (r.status === "dry_run") throw new Error("unexpected dry_run");
    expect(r.meta.engine).toBe("vision");
    expect(r.field_source?.merchant).toBe("model");
  });
});
