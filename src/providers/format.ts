import type { JsonSchema } from "@parserelay/core";
import type { FieldSpec } from "../scan/schema";

/** The wrapper shape we force the model to return. */
export interface ExtractionShape {
  /** JSON Schema for `{ fields, confidence, notes }`. */
  schema: Record<string, unknown>;
  systemPrompt: string;
}

/**
 * Turn a caller's JSON Schema node into a forced-output field schema, faithfully
 * (preserving `type` + nested `items`/`properties`) but tolerating `null` at the
 * top level so the model can still decline ("never guess") without violating the
 * schema. This is what keeps `total: number` a number and `line_items:
 * array<object>` an array of objects rather than strings.
 */
function nullableField(node: JsonSchema): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...node };
  // `type` is loosely typed (JSON Schema allows a string OR a string[] union).
  const t: unknown = node.type;
  if (Array.isArray(node.enum)) {
    clone.enum = [...node.enum, null];
  } else if (Array.isArray(t)) {
    // A type union like ["number","integer"] — add null without duplicating it.
    clone.type = t.includes("null") ? t : [...t, "null"];
  } else if (typeof t === "string") {
    clone.type = t === "null" ? "null" : [t, "null"];
  } else if (node.minimum !== undefined || node.maximum !== undefined) {
    clone.type = ["number", "null"];
  } else {
    // No type/enum/bounds: fall back to the permissive scalar union.
    clone.type = ["string", "number", "null"];
  }
  return clone;
}

/** Field-list shorthand (no schema node): a permissive scalar that allows null. */
function shorthandField(spec: FieldSpec): Record<string, unknown> {
  if (spec.enum && spec.enum.length > 0) {
    return { enum: [...spec.enum, null], description: spec.description };
  }
  if (spec.minimum !== undefined || spec.maximum !== undefined) {
    return { type: ["number", "null"], description: spec.description };
  }
  return { type: ["string", "number", "null"], description: spec.description };
}

/**
 * Build the structured-output schema + system prompt from the requested fields.
 * Each field's `description` (the schema's "triple duty") is fed to the model as
 * its extraction instruction. The model returns a value AND a 0–1 confidence per
 * field, and is told to prefer null over guessing.
 */
export function buildExtractionShape(specs: FieldSpec[], docType: string): ExtractionShape {
  const fieldProps: Record<string, unknown> = {};
  const confProps: Record<string, unknown> = {};
  for (const s of specs) {
    fieldProps[s.name] = s.schema ? nullableField(s.schema) : shorthandField(s);
    confProps[s.name] = { type: "number", description: "0–1 confidence the value is correct" };
  }

  const hasSpecs = specs.length > 0;
  const fields = hasSpecs
    ? { type: "object", properties: fieldProps, required: specs.map((s) => s.name) }
    : { type: "object", additionalProperties: true };
  const confidence = hasSpecs
    ? { type: "object", properties: confProps }
    : { type: "object", additionalProperties: { type: "number" } };

  const schema = {
    type: "object",
    properties: {
      fields,
      confidence,
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["fields", "confidence", "notes"],
  };

  const noun = docType === "freeform" ? "document" : docType;
  const want = hasSpecs
    ? `Extract exactly these fields: ${specs.map((s) => s.name).join(", ")}.`
    : "Extract the salient fields from the document.";
  const systemPrompt = [
    `You read a ${noun} from an image and return structured data.`,
    want,
    "Also return a 0–1 confidence per field. Follow each field's description.",
    "Match each field's specified type and structure exactly: numbers as numbers (no currency symbols or units), arrays of objects as objects with the named keys.",
    "If a value is shown as a range like 20-40, return the midpoint.",
    "Never guess: if a field is absent or unreadable, return null with low confidence.",
  ].join(" ");

  return { schema, systemPrompt };
}
