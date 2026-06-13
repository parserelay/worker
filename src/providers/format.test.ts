import type { JsonSchema, ScanSchema } from "@parserelay/core";
import { describe, expect, it } from "vitest";
import { toFieldSpecs } from "../scan/schema";
import { buildExtractionShape } from "./format";

/** The `fields` object node of the forced-output schema for a given request schema. */
function fieldsNode(schema: ScanSchema): JsonSchema {
  const built = buildExtractionShape(toFieldSpecs(schema), "receipt")
    .schema as unknown as JsonSchema;
  return built.properties?.fields as JsonSchema;
}

describe("buildExtractionShape — schema fidelity", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: {
      merchant: { type: "string" },
      total: { type: "number" },
      line_items: {
        type: "array",
        items: {
          type: "object",
          properties: { description: { type: "string" }, amount: { type: "number" } },
          required: ["description", "amount"],
        },
      },
    },
    required: ["merchant", "total", "line_items"],
  };

  it("keeps number-typed fields numeric (nullable), not the permissive union", () => {
    const total = fieldsNode(schema).properties?.total as JsonSchema;
    expect(total.type).toEqual(["number", "null"]);
  });

  it("preserves nested array<object> item shape", () => {
    const li = fieldsNode(schema).properties?.line_items as JsonSchema;
    expect(li.type).toEqual(["array", "null"]);
    expect((li.items?.properties?.amount as JsonSchema).type).toBe("number");
    expect(li.items?.required).toEqual(["description", "amount"]);
  });

  it("forces every field present (nullable) so absent values surface as null", () => {
    const fields = fieldsNode(schema);
    expect(fields.required).toEqual(["merchant", "total", "line_items"]);
    expect((fields.properties?.merchant as JsonSchema).type).toEqual(["string", "null"]);
  });

  it("appends null to enum fields", () => {
    const status = fieldsNode({
      type: "object",
      properties: { status: { enum: ["open", "closed"] } },
    }).properties?.status as JsonSchema;
    expect(status.enum).toEqual(["open", "closed", null]);
  });

  it("adds null to a type-union field without duplicating it", () => {
    const props = fieldsNode({
      type: "object",
      properties: {
        a: { type: ["number", "integer"] } as unknown as JsonSchema,
        b: { type: ["string", "null"] } as unknown as JsonSchema,
      },
    });
    expect((props.properties?.a as JsonSchema).type).toEqual(["number", "integer", "null"]);
    expect((props.properties?.b as JsonSchema).type).toEqual(["string", "null"]);
  });

  it("preserves object-typed fields (nullable) with their nested properties", () => {
    const addr = fieldsNode({
      type: "object",
      properties: {
        address: { type: "object", properties: { city: { type: "string" } } },
      },
    }).properties?.address as JsonSchema;
    expect(addr.type).toEqual(["object", "null"]);
    expect((addr.properties?.city as JsonSchema).type).toBe("string");
  });

  it("field-list shorthand stays a permissive nullable scalar", () => {
    const merchant = fieldsNode(["merchant", "total"]).properties?.merchant as JsonSchema;
    expect(merchant.type).toEqual(["string", "number", "null"]);
  });
});
