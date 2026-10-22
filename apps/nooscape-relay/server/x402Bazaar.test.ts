import { describe, expect, it } from "vitest";
import { problems, schemaOf } from "./apiV1Check";
import { bazaarFor, checkDiscovery, CHECK_BODY_EXAMPLE, CHECK_OUTPUT_EXAMPLE, LOOKUP_ROUTE_TEMPLATE, lookupDiscovery, type BazaarExtension } from "./x402Bazaar";

/**
 * The Bazaar block of a 402 (docs/x402-discovery-2026-10-21.md). The reference package's validator checks that `info` validates against
 * `schema`, and a pair that does not is dropped without a word. The repo has no JSON Schema validator, so the first two tests pin the
 * exact blocks (they were built with the reference package and checked with its validator when they were written) and the third checks
 * the one property that matters in code: that what `info` says is what `schema` allows.
 */

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
/** An en dash or an em dash, built from their code points so this file holds none. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("the check's block", () => {
  it("is the reference package's shape for a JSON body, with the check's own body schema", () => {
    expect(checkDiscovery()).toEqual({
      info: {
        input: { type: "http", method: "POST", bodyType: "json", body: { agent: { chain: "arc", id: "1" } } },
        output: {
          type: "json",
          example: {
            data: {
              subject: { type: "agent", value: "arc/1" },
              results: [
                {
                  evidence: { level: "checked_unproven" },
                  flags: { first_seen: { present: false }, ownership_changes: { present: false }, revoked_feedback: { present: null }, fleet: { present: false } },
                },
              ],
            },
          },
        },
      },
      schema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["POST"] },
              bodyType: { type: "string", enum: ["json"] },
              body: {
                type: "object",
                properties: {
                  agent: { type: "object", properties: { chain: { type: "string" }, id: { type: "string" } }, required: ["chain", "id"] },
                  wallet: { type: "string" },
                  url: { type: "string" },
                  chain: { type: "string" },
                },
                oneOf: [{ required: ["agent"] }, { required: ["wallet"] }, { required: ["url"] }],
              },
            },
            required: ["type", "method", "bodyType", "body"],
            additionalProperties: false,
          },
          // What the reference package declares for an answer shown as an example: AgentCash's validator calls a block without it an error.
          output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
        },
        required: ["input"],
      },
    });
  });
});

describe("the lookup's block", () => {
  it("is the reference package's shape for a GET with path parameters, with the route template", () => {
    expect(lookupDiscovery({ chain: "base", id: "42" })).toEqual({
      info: { input: { type: "http", method: "GET", queryParams: {}, pathParams: { chain: "base", id: "42" } } },
      schema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET"] },
              queryParams: { type: "object", properties: {} },
              pathParams: {
                type: "object",
                properties: { chain: { type: "string" }, id: { type: "string" } },
                required: ["chain", "id"],
              },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
        },
        required: ["input"],
      },
      routeTemplate: "/api/v1/agents/:chain/:id",
    });
  });

  it("falls back to the example for a path that does not read as one, and never throws whatever it is given", () => {
    const example = { chain: "arc", id: "1" };
    for (const url of ["not a url", "", "https://nooscape.si/api/v1/agents", "https://nooscape.si/api/v1/agents/arc", "https://nooscape.si/api/v1/agents/arc/1/history", "https://nooscape.si/other/arc/1", "https://[::1"]) {
      expect(bazaarFor("agent", url).info.input.pathParams, url).toEqual(example);
    }
    expect(bazaarFor("agent", "https://nooscape.si/api/v1/agents/bnb/12345").info.input.pathParams).toEqual({ chain: "bnb", id: "12345" });
    expect(bazaarFor("agent", "https://nooscape.si/api/v1/agents/%zz/1%20").info.input.pathParams).toEqual({ chain: "%zz", id: "1%20" });
  });

  it("is the one block for a route and the other for the check, whatever the address", () => {
    expect(bazaarFor("check", "https://nooscape.si/api/v1/check")).toEqual(checkDiscovery());
    expect(bazaarFor("check", "anything")).toEqual(checkDiscovery());
    expect(bazaarFor("agent", "https://nooscape.si/api/v1/agents/arc/1").routeTemplate).toBe(LOOKUP_ROUTE_TEMPLATE);
  });
});

describe("what info says and what schema allows", () => {
  type Props = Record<string, { type?: string; const?: string; enum?: string[]; properties?: Props; required?: string[] }>;

  function inputOf(extension: BazaarExtension) {
    const schema = (extension.schema as { properties: { input: { properties: Props; required: string[]; additionalProperties: boolean } } }).properties.input;
    return { info: extension.info.input, props: schema.properties, required: schema.required, closed: schema.additionalProperties === false };
  }

  it.each([
    ["the check", checkDiscovery()],
    ["the lookup", lookupDiscovery()],
  ])("%s: every field of the example is allowed, every required one is there, and the method is the one the schema names", (_name, extension) => {
    const { info, props, required, closed } = inputOf(extension);
    expect(closed).toBe(true);
    for (const key of Object.keys(info)) expect(Object.keys(props), key).toContain(key);
    for (const key of required) expect(Object.keys(info), key).toContain(key);
    expect(info.type).toBe(props.type!.const);
    expect(props.method!.enum).toEqual([info.method]);
  });

  it("the check's example body is exactly one of the three the schema offers", () => {
    const { info, props } = inputOf(checkDiscovery());
    expect(props.bodyType!.enum).toContain(info.bodyType);
    const body = props.body as unknown as { properties: Record<string, unknown>; oneOf: Array<{ required: string[] }> };
    const matching = body.oneOf.filter(branch => branch.required.every(key => key in (info.body as object)));
    expect(matching).toHaveLength(1);
    expect(Object.keys(info.body as object).every(key => key in body.properties)).toBe(true);
    expect(info.body).toEqual(CHECK_BODY_EXAMPLE);
  });

  it("the lookup's path parameters are strings the schema names and requires", () => {
    const { info, props } = inputOf(lookupDiscovery({ chain: "arc", id: "7" }));
    const path = props.pathParams as unknown as { properties: Record<string, { type: string }>; required: string[] };
    for (const [key, value] of Object.entries(info.pathParams as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
      expect(path.properties[key]?.type).toBe("string");
    }
    expect(path.required.every(key => key in (info.pathParams as object))).toBe(true);
  });
});

describe("its size", () => {
  it("stays small, because the PAYMENT-REQUIRED header is the base64 of the body and a client sends the block back in its payment", () => {
    // The check's block was 790 bytes before it showed an answer; it is 1,185 with the output schema and the abridged example.
    expect(JSON.stringify(checkDiscovery()).length).toBeLessThan(1300);
    expect(JSON.stringify(lookupDiscovery()).length).toBeLessThan(700);
  });

  it("shows an answer for the check alone, and has no free text in either block", () => {
    expect(checkDiscovery().info.output).toEqual({ type: "json", example: CHECK_OUTPUT_EXAMPLE });
    expect(lookupDiscovery().info).not.toHaveProperty("output");
    for (const extension of [checkDiscovery(), lookupDiscovery()]) {
      expect(JSON.stringify(extension)).not.toContain("description");
      expect(JSON.stringify(extension)).not.toMatch(LONG_DASH);
    }
  });

  it("holds the abridged answer to the real one: every key is in the API's document with a type and a value it allows, and only what is left out is missing", () => {
    const found = problems(schemaOf("CheckResponse"), CHECK_OUTPUT_EXAMPLE);
    // An abridged example leaves keys out on purpose; nothing in it may be unknown, mistyped or out of the document's enum.
    expect(found.filter(line => !line.endsWith(": missing"))).toEqual([]);
    expect(found.some(line => line.endsWith(": missing"))).toBe(true);
  });

  it("the schema allows what the example says: an object with a type, and the example an object", () => {
    const schema = (checkDiscovery().schema as { properties: { output: { properties: { type: { type: string }; example: { type: string } }; required: string[] } } }).properties.output;
    expect(schema.required).toEqual(["type"]);
    expect(schema.properties.type.type).toBe("string");
    expect(schema.properties.example.type).toBe("object");
    expect(typeof checkDiscovery().info.output!.type).toBe("string");
    expect(typeof checkDiscovery().info.output!.example).toBe("object");
  });
});
