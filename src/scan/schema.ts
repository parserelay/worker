import type { JsonSchema, ScanSchema } from "@parserelay/core";

/**
 * A flattened view of one requested field, distilled from the schema's "triple
 * duty": the name, its prompt hint (`description`), and the bounds/enum that
 * feed the rescue gate (`minimum`/`maximum`/`enum`).
 */
export interface FieldSpec {
  name: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  required: boolean;
  /**
   * The field's raw JSON Schema node (only when the request used a Schema, not
   * field-list shorthand). Preserved so the model's forced output keeps the
   * field's `type` and nested `items`/`properties` shape.
   */
  schema?: JsonSchema;
}

/** Expand field-list shorthand OR a (top-level, flat) JSON Schema into specs. */
export function toFieldSpecs(schema: ScanSchema | undefined): FieldSpec[] {
  if (!schema) return [];
  if (Array.isArray(schema)) {
    return schema.map((name) => ({ name, required: false }));
  }
  const properties = (schema as JsonSchema).properties ?? {};
  const required = new Set((schema as JsonSchema).required ?? []);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    description: typeof prop.description === "string" ? prop.description : undefined,
    minimum: typeof prop.minimum === "number" ? prop.minimum : undefined,
    maximum: typeof prop.maximum === "number" ? prop.maximum : undefined,
    enum: Array.isArray(prop.enum) ? prop.enum : undefined,
    required: required.has(name),
    schema: prop,
  }));
}
