import { describe, expect, it } from "vitest";
import {
  deterministicParse,
  gateField,
  gateRow,
  normalizeScalar,
  ungroundedTokens,
} from "./extract";
import type { FieldSpec } from "./schema";

/** Minimal field specs from names (no schema constraints). */
const specs = (names: string[]): FieldSpec[] => names.map((name) => ({ name, required: false }));

// An unlabeled grocery receipt: no `merchant:` / `total:` labels anywhere.
const RECEIPT = [
  "SUPER C",
  "147 AVENUE ATWATER",
  "Date 29/05/2026",
  "SOUS-TOTAL 22.17",
  "TPS 0.39",
  "TVQ 0.77",
  "TOTAL 23.33",
].join("\n");

/**
 * Boundary tests for the value-grounding similarity logic. The
 * integration tests in run.test.ts cover the named policy cases; these guard the
 * exact thresholds in `isSupported` so a regression in the arithmetic (maxDist
 * scaling, prefix-extension cap) fails loudly rather than silently widening the
 * fabrication guard's blind spot.
 */
describe("ungroundedTokens", () => {
  it("returns nothing for an exact token match", () => {
    expect(ungroundedTokens("Acme", "Acme\nTotal 18.50")).toEqual([]);
  });

  it("treats a 1-edit substitution as a smudge correction (ATL→AIL)", () => {
    expect(ungroundedTokens("AIL", "ATL 3 UNI S")).toEqual([]);
  });

  it("treats a truncation within the cap as a smudge correction (UNI→UNITES)", () => {
    // "unites" is "uni" + 3 trailing chars — exactly PREFIX_MAX_EXTENSION.
    expect(ungroundedTokens("UNITES", "ATL 3 UNI S")).toEqual([]);
  });

  it("does NOT launder a short fragment via a much longer prefix-sharing word", () => {
    // "uni" shares a prefix with "universities" but is 9 chars shorter — beyond
    // the truncation cap, so it is not a correction of that word.
    expect(ungroundedTokens("uni", "campus universities open")).toEqual(["uni"]);
  });

  it("flags unrelated similar-length words 2 edits apart (toronto vs taranto)", () => {
    // len 7 → maxDist 1; edit distance 2 → unsupported. The case Finding 2 caught.
    expect(ungroundedTokens("toronto", "taranto port receipt")).toEqual(["toronto"]);
  });

  it("flags canada against banana (2 edits at len 6)", () => {
    expect(ungroundedTokens("canada", "banana split")).toEqual(["canada"]);
  });

  it("allows 2 edits on a longer word (montreel→montreal, len 8 → maxDist 2)", () => {
    expect(ungroundedTokens("montreel", "montreal qc")).toEqual([]);
  });

  it("flags a fabricated word with no anchor (Montreal appended to an address)", () => {
    expect(ungroundedTokens("147, Avenue Atwater, Montreal", "147 AVENUE ATWATER")).toEqual([
      "montreal",
    ]);
  });

  it("allows a 1-edit difference on a 2-char token (≥2-char significance threshold)", () => {
    expect(ungroundedTokens("ab", "ac de")).toEqual([]);
  });

  it("never flags non-strings or all-numeric strings", () => {
    expect(ungroundedTokens(42, "anything")).toEqual([]);
    expect(ungroundedTokens("2026-05-29", "no digits here")).toEqual([]); // reformatted date
  });
});

describe("deterministicParse positional heuristics", () => {
  it("still prefers an explicit label:value match (not positional)", () => {
    const r = deterministicParse("merchant: Acme\ntotal: 18.50", specs(["merchant", "total"]));
    expect(r.merchant).toEqual({ value: "Acme", positional: false });
    expect(r.total).toEqual({ value: 18.5, positional: false });
  });

  it("resolves an unlabeled merchant from the header line", () => {
    expect(deterministicParse(RECEIPT, specs(["merchant"])).merchant).toEqual({
      value: "SUPER C",
      positional: true,
    });
  });

  it("resolves the grand total from a TOTAL line, skipping SOUS-TOTAL", () => {
    expect(deterministicParse(RECEIPT, specs(["total"])).total).toEqual({
      value: 23.33,
      positional: true,
    });
  });

  it("resolves a date token positionally when it isn't labeled with a colon", () => {
    expect(deterministicParse(RECEIPT, specs(["date"])).date).toEqual({
      value: "29/05/2026",
      positional: true,
    });
  });

  it("does NOT let a subtotal field grab the grand total", () => {
    // No subtotal heuristic; the total fallback is guarded off for `sub*` names.
    expect(deterministicParse(RECEIPT, specs(["subtotal"])).subtotal).toEqual({
      value: null,
      positional: false,
    });
  });

  it("never guesses an unrecognized field — it stays null", () => {
    expect(deterministicParse(RECEIPT, specs(["color"])).color).toEqual({
      value: null,
      positional: false,
    });
  });

  it("does NOT mis-fire on a compound total field (total_tax stays null, not the grand total)", () => {
    // Exact-name match: total_tax / total_items must not return the 23.33 grand total.
    const r = deterministicParse(RECEIPT, specs(["total_tax", "total_items"]));
    expect(r.total_tax).toEqual({ value: null, positional: false });
    expect(r.total_items).toEqual({ value: null, positional: false });
  });

  it("does NOT mis-fire on a merchant sub-attribute (vendor_id / shop_address stay null)", () => {
    const r = deterministicParse(RECEIPT, specs(["vendor_id", "shop_address"]));
    expect(r.vendor_id).toEqual({ value: null, positional: false });
    expect(r.shop_address).toEqual({ value: null, positional: false });
  });

  it("still resolves a recognized compound merchant name (merchant_name)", () => {
    expect(deterministicParse(RECEIPT, specs(["merchant_name"])).merchant_name).toEqual({
      value: "SUPER C",
      positional: true,
    });
  });

  it("resolves a compound date field name, but not a lookalike (mandate)", () => {
    const r = deterministicParse(RECEIPT, specs(["invoice_date", "mandate"]));
    expect(r.invoice_date).toEqual({ value: "29/05/2026", positional: true });
    expect(r.mandate).toEqual({ value: null, positional: false });
  });

  it("parses a US-formatted grand total with a thousands comma (1,234.56)", () => {
    const text = "STORE\nSOUS-TOTAL 1,100.00\nTOTAL 1,234.56";
    expect(deterministicParse(text, specs(["total"])).total).toEqual({
      value: 1234.56,
      positional: true,
    });
  });
});

describe("normalizeScalar number locales", () => {
  it("US thousands + decimal (1,234.56)", () => expect(normalizeScalar("1,234.56")).toBe(1234.56));
  it("EU thousands + decimal (1.234,56)", () => expect(normalizeScalar("1.234,56")).toBe(1234.56));
  it("US thousands, no decimal (1,234)", () => expect(normalizeScalar("1,234")).toBe(1234));
  it("EU thousands, no decimal (1.234)", () => expect(normalizeScalar("1.234")).toBe(1234));
  it("EU decimal comma (12,5)", () => expect(normalizeScalar("12,5")).toBe(12.5));
  it("plain decimal (23.33)", () => expect(normalizeScalar("23.33")).toBe(23.33));
  it("millions, US (1,234,567.89)", () => expect(normalizeScalar("1,234,567.89")).toBe(1234567.89));
  it("negative US (-1,234.56)", () => expect(normalizeScalar("-1,234.56")).toBe(-1234.56));
  it("non-numeric passes through unchanged", () =>
    expect(normalizeScalar("SUPER C")).toBe("SUPER C"));
});

describe("gateField — rescue predicates", () => {
  const f = (over: Partial<FieldSpec>): FieldSpec => ({ name: "f", required: false, ...over });

  it("missing required vs unparsed optional", () => {
    expect(gateField(f({ required: true }), null)).toBe("missing_required");
    expect(gateField(f({ required: false }), null)).toBe("unparsed");
  });

  it("out-of-range numbers (schema-derived)", () => {
    expect(gateField(f({ minimum: 0 }), -1)).toBe("out_of_range");
    expect(gateField(f({ maximum: 100 }), 101)).toBe("out_of_range");
    expect(gateField(f({ minimum: 0, maximum: 100 }), 50)).toBeNull();
  });

  it("garbled glyphs in a numeric field", () => {
    expect(gateField(f({ minimum: 0 }), "12O.5")).toBe("garbled_glyphs"); // letter O
  });

  it("distinguishes low_fuzzy_match from not_in_enum", () => {
    const card = f({ enum: ["Visa", "Mastercard", "Amex"] });
    expect(gateField(card, "Mastercard")).toBeNull(); // exact → clean
    expect(gateField(card, "Mastercrad")).toBe("low_fuzzy_match"); // typo (dist 2)
    expect(gateField(card, "Discover")).toBe("not_in_enum"); // no near match
  });
});

describe("gateRow — sparse-row predicate", () => {
  const cols = ["desc", "qty", "unit_price", "amount"];

  it("flags a row missing more than half its columns", () => {
    expect(gateRow({ desc: "Widget", qty: null, unit_price: null, amount: null }, cols)).toBe(
      "sparse_row",
    );
  });

  it("passes a mostly-filled row", () => {
    expect(gateRow({ desc: "Widget", qty: 2, unit_price: 5, amount: 10 }, cols)).toBeNull();
  });

  it("counts blank strings as empty", () => {
    expect(gateRow({ desc: "  ", qty: "", unit_price: "", amount: 10 }, cols)).toBe("sparse_row");
  });

  it("exactly half empty is not sparse (boundary)", () => {
    expect(gateRow({ desc: "Widget", qty: 2, unit_price: null, amount: null }, cols)).toBeNull();
  });

  it("no columns → clean", () => {
    expect(gateRow({}, [])).toBeNull();
  });
});
