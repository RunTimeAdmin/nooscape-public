import type { X402Endpoint } from "./x402";

/**
 * The Bazaar discovery extension of a 402 (`extensions.bazaar`, https://docs.cdp.coinbase.com/x402/seller/get-discovered): what the 402
 * says about how to call the route that is asking for payment. A client or an indexer that reads it can build a valid call without
 * reading our documentation: the method, the body or the path, and a JSON Schema the example validates against.
 *
 * The shape is the one the x402 reference package (`@x402/extensions`, bazaar) builds and checks: `info` must validate against `schema`,
 * and a pair that does not is dropped by a validator without a word (payment still works, the route is just not described). Both
 * calls below were built with that package and checked with its validator when this was written (docs/x402-discovery-2026-10-21.md).
 *
 * It describes the calls, and shows the shape of the check's answer without promising what any answer holds. The 402's PAYMENT-REQUIRED
 * header is the base64 of the body and a client sends the extensions back inside its payment, so every byte here is carried three times
 * and the header block of the 402 must stay well under the 4 KB a proxy may buffer (it was about 2 KB before this block, 3.2 KB with the
 * input, and 3.9 KB at the edge with Base). The check's answer is shown abridged, to the keys that name what it returns and nothing that
 * reads as prose: AgentCash's validator calls a block with no output schema an error, nearly every listing in the Bazaar carries an
 * example (67 of 68 sampled on 21 October 2026), and Coinbase ranks a listing by how complete it is. The Bazaar refuses a listing whose
 * metadata could be read as an instruction to an agent, so there is no free text here to misread. The OpenAPI document and /llms.txt say
 * what the fields mean and what comes back in full. To make room, a payment reply drops the headers only a document needs (apiV1.ts).
 *
 * Nothing here is read back. A payment is judged on the terms we build ourselves (server/x402.ts `requirements`), and the body we
 * send the facilitator is built from our own terms too, so a client that sends a changed copy of this block changes nothing.
 */

const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type BazaarExtension = {
  info: { input: Record<string, unknown>; output?: { type: "json"; example: Record<string, unknown> } };
  schema: Record<string, unknown>;
  /** Present for a route with a path parameter, in the `:name` form the reference package uses. */
  routeTemplate?: string;
};

/** The schema the reference package builds around a route's input: type and method are fixed, and `extra` says the rest. */
function inputSchema(method: string, extra: Record<string, unknown>, required: string[], output = false): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: [method] }, ...extra },
        required: ["type", "method", ...required],
        additionalProperties: false,
      },
      ...(output ? { output: OUTPUT_SCHEMA } : {}),
    },
    required: ["input"],
  };
}

/** What the reference package declares for an answer shown as an example: its type, and the example as an object. */
const OUTPUT_SCHEMA = { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] };

/** POST /api/v1/check: the body is exactly one of agent, wallet or url, and a chain may narrow the last two. */
export const CHECK_BODY_EXAMPLE = { agent: { chain: "arc", id: "1" } } as const;

const CHECK_BODY_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "object", properties: { chain: { type: "string" }, id: { type: "string" } }, required: ["chain", "id"] },
    wallet: { type: "string" },
    url: { type: "string" },
    chain: { type: "string" },
  },
  oneOf: [{ required: ["agent"] }, { required: ["wallet"] }, { required: ["url"] }],
};

/**
 * The shape of the check's answer, abridged: the subject, and for each listing the evidence level and the four flags with whether each is
 * present (true, false, or null for not measured). A real answer also carries the dates, the sources, the basis of each flag and the
 * statement; apiV1Spec.ts has all of it, and a test holds every key here to that document.
 */
export const CHECK_OUTPUT_EXAMPLE = {
  data: {
    subject: { type: "agent", value: "arc/1" },
    results: [
      {
        evidence: { level: "checked_unproven" },
        flags: { first_seen: { present: false }, ownership_changes: { present: false }, revoked_feedback: { present: null }, fleet: { present: false } },
      },
    ],
  },
} as const;

export function checkDiscovery(): BazaarExtension {
  return {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: CHECK_BODY_EXAMPLE },
      output: { type: "json", example: CHECK_OUTPUT_EXAMPLE },
    },
    schema: inputSchema("POST", { bodyType: { type: "string", enum: ["json"] }, body: CHECK_BODY_SCHEMA }, ["bodyType", "body"], true),
  };
}

/** GET /api/v1/agents/{chain}/{id}: the path names the chain and the agent's id, and a query is not used. */
export const LOOKUP_ROUTE_TEMPLATE = "/api/v1/agents/:chain/:id";
const LOOKUP_PATH = /^\/api\/v1\/agents\/([^/]+)\/([^/]+)$/;
const LOOKUP_EXAMPLE = { chain: "arc", id: "1" };

export function lookupDiscovery(pathParams: { chain: string; id: string } = LOOKUP_EXAMPLE): BazaarExtension {
  return {
    info: { input: { type: "http", method: "GET", queryParams: {}, pathParams } },
    schema: inputSchema(
      "GET",
      {
        queryParams: { type: "object", properties: {} },
        pathParams: {
          type: "object",
          properties: { chain: { type: "string" }, id: { type: "string" } },
          required: ["chain", "id"],
        },
      },
      []
    ),
    routeTemplate: LOOKUP_ROUTE_TEMPLATE,
  };
}

/**
 * The block for the route a 402 is for. The lookup's path parameters are those of the request being answered, as the reference package
 * fills them in, and an address that does not read as one (it must not throw: a stranger chose it) falls back to the example. Both are
 * only text in the extension, which nothing here acts on.
 */
export function bazaarFor(endpoint: X402Endpoint, resourceUrl: string): BazaarExtension {
  if (endpoint === "check") return checkDiscovery();
  try {
    const found = LOOKUP_PATH.exec(new URL(resourceUrl).pathname);
    return lookupDiscovery(found ? { chain: found[1]!, id: found[2]! } : LOOKUP_EXAMPLE);
  } catch {
    return lookupDiscovery();
  }
}
