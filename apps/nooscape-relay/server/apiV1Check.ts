import { API_V1_SPEC } from "./apiV1Spec";

/**
 * A checker for the part of JSON Schema the API's OpenAPI document uses (type, enum, const, properties, required,
 * additionalProperties (false, or a schema), items, minItems, maxItems, oneOf, format date-time and $ref), so a test can hold what the API answers to what the document says.
 * Tests only: no code that serves a request imports this file (server/apiV1.test.ts fails if one does).
 */

export type Schema = Record<string, unknown>;


/** The document a reference is read from: the one the API serves with every extra chain off, or one a test passes (apiV1SpecFor). */
type Spec = { components: { schemas: unknown } };

function resolve(schema: Schema, spec: Spec): Schema {
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  const name = reference.replace("#/components/schemas/", "");
  return (spec.components.schemas as Record<string, Schema>)[name]!;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** Every way `value` does not fit `schema`, as readable lines; empty when it fits. */
export function problems(schemaIn: Schema, value: unknown, path = "$", spec: Spec = API_V1_SPEC): string[] {
  const schema = resolve(schemaIn, spec);
  const found: string[] = [];
  if ("const" in schema && value !== schema.const) found.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) found.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types.length > 0) {
    const actual = typeOf(value);
    const ok = types.some(type => type === actual || (type === "number" && actual === "integer"));
    if (!ok) return [...found, `${path}: expected ${types.join(" or ")}, got ${actual}`];
  }
  if (Array.isArray(schema.oneOf)) {
    const fits = (schema.oneOf as Schema[]).filter(option => problems(option, value, path, spec).length === 0).length;
    if (fits !== 1) found.push(`${path}: fits ${fits} of the oneOf options, expected exactly 1`);
  }
  if (schema.format === "date-time" && typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) found.push(`${path}: not a date-time`);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) found.push(`${path}.${key}: missing`);
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) found.push(...problems(properties[key]!, item, `${path}.${key}`, spec));
      else if (schema.additionalProperties === false) found.push(`${path}.${key}: not in the document`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") found.push(...problems(schema.additionalProperties as Schema, item, `${path}.${key}`, spec));
    }
  }
  if (Array.isArray(value) && typeof schema.minItems === "number" && value.length < schema.minItems) found.push(`${path}: fewer than ${schema.minItems} items`);
  if (Array.isArray(value) && typeof schema.maxItems === "number" && value.length > schema.maxItems) found.push(`${path}: more than ${schema.maxItems} items`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => found.push(...problems(schema.items as Schema, item, `${path}[${index}]`, spec)));
  return found;
}

export const schemaOf = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

